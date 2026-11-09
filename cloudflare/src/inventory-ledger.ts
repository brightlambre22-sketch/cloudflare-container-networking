import { DurableObject } from "cloudflare:workers";

type LedgerItem = { product_id: string; quantity: number };
const ACCOUNT_ID = /^acct-[a-f0-9-]{36}$/;
const UUID = /^[a-f0-9-]{36}$/;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

/**
 * Always-online inventory authority for one business.
 *
 * TinyCore remains the local Stockroom database. This object owns online
 * reservations, offline POS allocations, and the durable order outbox.
 */
export class InventoryLedger extends DurableObject {
  private schema() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_catalog (product_id TEXT PRIMARY KEY, sku TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', variations_json TEXT NOT NULL DEFAULT '[]', external_url TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, on_hand INTEGER NOT NULL CHECK(on_hand >= 0), offline_allocated INTEGER NOT NULL DEFAULT 0 CHECK(offline_allocated >= 0), status TEXT NOT NULL DEFAULT 'active', source_updated_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_reservations (id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('active','committed','released','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_reservation_items (checkout_id TEXT NOT NULL, product_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0), unit_price_cents INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(checkout_id, product_id))");
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_orders (order_id TEXT PRIMARY KEY, checkout_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS offline_sales (event_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS offline_allocations (allocation_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('active','consumed','released')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL DEFAULT '')");
    const allocationExpiryColumns = sql.exec("PRAGMA table_info(offline_allocations)").toArray() as Array<{name:string}>;
    if (!allocationExpiryColumns.some(column => column.name === "expires_at")) sql.exec("ALTER TABLE offline_allocations ADD COLUMN expires_at TEXT NOT NULL DEFAULT ''");
    sql.exec("UPDATE offline_allocations SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+24 hours') WHERE expires_at=''");
    sql.exec("CREATE TABLE IF NOT EXISTS offline_allocation_items (allocation_id TEXT NOT NULL, product_id TEXT NOT NULL, allocated INTEGER NOT NULL CHECK(allocated > 0), remaining INTEGER NOT NULL CHECK(remaining >= 0), unit_price_cents INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL DEFAULT '', PRIMARY KEY(allocation_id, product_id))");
    const allocationColumns = sql.exec("PRAGMA table_info(offline_allocation_items)").toArray() as Array<{name:string}>;
    if (!allocationColumns.some(column => column.name === "unit_price_cents")) sql.exec("ALTER TABLE offline_allocation_items ADD COLUMN unit_price_cents INTEGER NOT NULL DEFAULT 0");
    if (!allocationColumns.some(column => column.name === "name")) sql.exec("ALTER TABLE offline_allocation_items ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    sql.exec("UPDATE offline_allocation_items SET unit_price_cents=(SELECT price_cents FROM inventory_catalog WHERE product_id=offline_allocation_items.product_id), name=(SELECT name FROM inventory_catalog WHERE product_id=offline_allocation_items.product_id) WHERE unit_price_cents=0 AND name=''");
    sql.exec("CREATE INDEX IF NOT EXISTS reservations_expiry ON inventory_reservations(status, expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS orders_pending ON inventory_orders(status, created_at)");
  }

  async fetch(request: Request): Promise<Response> {
    this.schema();
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    const now = new Date().toISOString();
    this.expireOfflineAllocations(now);

    // Account deletion must erase the durable online catalog, reservations,
    // order outbox, and offline POS allocations for this merchant.
    if (url.pathname === "/purge" && request.method === "POST") {
      this.ctx.storage.transactionSync(() => {
        for (const table of [
          "inventory_reservation_items", "inventory_reservations", "inventory_orders",
          "offline_allocation_items", "offline_allocations", "offline_sales", "inventory_catalog",
        ]) sql.exec("DELETE FROM " + table);
      });
      return json({ ok: true, purged: true });
    }

    if (url.pathname === "/catalog/sync" && request.method === "PUT") {
      const body = await request.json().catch(() => null) as { products?: unknown } | null;
      if (!Array.isArray(body?.products) || body.products.length > 5000) return json({ error: "invalid_catalog" }, 400);
      let synced = 0;
      try {
      this.ctx.storage.transactionSync(() => {
      this.expireReservations(now);
      for (const raw of body.products) {
        if (!raw || typeof raw !== "object") continue;
        const p = raw as Record<string, unknown>;
        const id = typeof p.id === "string" ? p.id : "";
        const sku = typeof p.sku === "string" ? p.sku.slice(0, 64) : "";
        const name = typeof p.name === "string" ? p.name.slice(0, 120) : "";
        const description = typeof p.description === "string" ? p.description.slice(0, 2000) : "";
        const category = typeof p.category === "string" ? p.category.slice(0, 80) : "";
        const imageUrl = typeof p.image_url === "string" ? p.image_url.slice(0, 2048) : "";
        const variationsJson = typeof p.variations_json === "string" && p.variations_json.length <= 20000 ? p.variations_json : "[]";
        const externalUrl = typeof p.external_url === "string" ? p.external_url.slice(0, 2048) : "";
        const price = Number(p.price_cents);
        const quantity = Number(p.quantity);
        const status = p.status === "active" ? "active" : "inactive";
        const updated = typeof p.updated_at === "string" ? p.updated_at : now;
        if (!UUID.test(id) || !sku || !name || !Number.isSafeInteger(price) || price < 0 ||
            !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000000) continue;
        const prior = sql.exec("SELECT source_updated_at,offline_allocated FROM inventory_catalog WHERE product_id=?", id).toArray()[0] as { source_updated_at: string; offline_allocated: number } | undefined;
        // Never let an older local snapshot overwrite newer central inventory state.
        if (prior && updated <= prior.source_updated_at) continue;
        const reservedRow = sql.exec("SELECT COALESCE(SUM(i.quantity),0) AS held FROM inventory_reservation_items i JOIN inventory_reservations r ON r.checkout_id=i.checkout_id WHERE i.product_id=? AND r.status='active'",id).toArray()[0] as {held:number}|undefined;
        const held = Number(prior?.offline_allocated ?? 0) + Number(reservedRow?.held ?? 0);
        if (quantity < held) throw new Error("catalog_update_conflicts_with_reserved_stock:" + id);
        sql.exec("INSERT INTO inventory_catalog(product_id,sku,name,description,category,image_url,variations_json,external_url,price_cents,on_hand,offline_allocated,status,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(product_id) DO UPDATE SET sku=excluded.sku,name=excluded.name,description=excluded.description,category=excluded.category,image_url=excluded.image_url,variations_json=excluded.variations_json,external_url=excluded.external_url,price_cents=excluded.price_cents,on_hand=excluded.on_hand,status=excluded.status,source_updated_at=excluded.source_updated_at",
          id, sku, name, description, category, imageUrl, variationsJson, externalUrl, price, quantity, status, updated);
        synced++;
      }
      });
      } catch (error) {
        const message = String(error);
        if (message.startsWith("catalog_update_conflicts_with_reserved_stock:")) return json({ error: "catalog_update_conflicts_with_reserved_stock", product_id: message.split(":")[1] }, 409);
        throw error;
      }
      return json({ ok: true, synced });
    }

    if (url.pathname === "/catalog" && request.method === "GET") {
      this.expireReservations(now);
      const rows = sql.exec("SELECT c.product_id AS id,c.sku,c.name,c.description,c.category,c.image_url,c.variations_json,c.external_url,c.price_cents,c.on_hand,c.offline_allocated,c.status,COALESCE((SELECT SUM(i.quantity) FROM inventory_reservation_items i JOIN inventory_reservations r ON r.checkout_id=i.checkout_id WHERE i.product_id=c.product_id AND r.status='active'),0) AS online_reserved FROM inventory_catalog c WHERE c.status='active' ORDER BY c.name LIMIT 500").toArray() as Array<Record<string, unknown>>;
      return json({ ok: true, products: rows.map(p => ({ id:p.id, sku:p.sku, name:p.name, description:p.description, category:p.category,
        image_url:p.image_url, variations:JSON.parse(String(p.variations_json || "[]")), external_url:p.external_url,
        price:Number(p.price_cents)/100, quantity:Math.max(0,Number(p.on_hand)-Number(p.offline_allocated)-Number(p.online_reserved)),
        in_stock:Number(p.on_hand)-Number(p.offline_allocated)-Number(p.online_reserved)>0 })) });
    }

    if (url.pathname === "/reserve" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { checkout_id?: unknown; items?: unknown; ttl_seconds?: unknown } | null;
      const checkoutId = typeof body?.checkout_id === "string" ? body.checkout_id : "";
      if (!UUID.test(checkoutId) || !Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) return json({ error:"invalid_reservation" },400);
      const prior = sql.exec("SELECT status,expires_at FROM inventory_reservations WHERE checkout_id=?",checkoutId).toArray()[0] as {status:string;expires_at:string}|undefined;
      if (prior) {
        if (prior.status !== "active" || prior.expires_at <= now) return json({error:"reservation_not_active"},409);
        const saved = sql.exec("SELECT product_id,quantity,unit_price_cents,name FROM inventory_reservation_items WHERE checkout_id=?",checkoutId).toArray() as Array<Record<string,unknown>>;
        return json({ok:true,already_reserved:true,checkout_id:checkoutId,expires_at:prior.expires_at,
          items:saved.map(x=>({product_id:x.product_id,quantity:x.quantity,unit_amount_usd:(Number(x.unit_price_cents)/100).toFixed(2),name:x.name})),
          amount_cents:saved.reduce((sum,x)=>sum+Number(x.unit_price_cents)*Number(x.quantity),0)});
      }
      const requested = new Map<string,number>();
      for (const item of body.items) {
        if (!item || typeof item !== "object") return json({error:"invalid_inventory_item"},400);
        const value=item as Record<string,unknown>;
        if (typeof value.product_id !== "string" || !UUID.test(value.product_id) || !Number.isInteger(value.quantity) || Number(value.quantity)<1 || Number(value.quantity)>99) return json({error:"invalid_inventory_item"},400);
        requested.set(value.product_id,(requested.get(value.product_id)??0)+Number(value.quantity));
      }
      this.expireReservations(now);
      const selected: Array<{id:string;quantity:number;price:number;name:string}> = [];
      for (const [productId,quantity] of requested) {
        const row=sql.exec("SELECT c.product_id,c.name,c.price_cents,c.on_hand,c.offline_allocated,COALESCE((SELECT SUM(i.quantity) FROM inventory_reservation_items i JOIN inventory_reservations r ON r.checkout_id=i.checkout_id WHERE i.product_id=c.product_id AND r.status='active'),0) AS reserved FROM inventory_catalog c WHERE c.product_id=? AND c.status='active'",productId).toArray()[0] as Record<string,unknown>|undefined;
        if (!row || Number(row.on_hand)-Number(row.offline_allocated)-Number(row.reserved)<quantity) return json({error:"insufficient_stock",product_id:productId},409);
        selected.push({id:productId,quantity,price:Number(row.price_cents),name:String(row.name)});
      }
      const ttl=Math.min(1800,Math.max(60,Number(body.ttl_seconds)||1800));
      const expires=new Date(Date.now()+ttl*1000).toISOString();
      this.ctx.storage.transactionSync(() => {
        sql.exec("INSERT INTO inventory_reservations(id,checkout_id,status,expires_at,created_at) VALUES(?,?,'active',?,?)",crypto.randomUUID(),checkoutId,expires,now);
        for (const item of selected) sql.exec("INSERT INTO inventory_reservation_items(checkout_id,product_id,quantity,unit_price_cents,name) VALUES(?,?,?,?,?)",checkoutId,item.id,item.quantity,item.price,item.name);
      });
      return json({ok:true,checkout_id:checkoutId,expires_at:expires,items:selected.map(x=>({product_id:x.id,quantity:x.quantity,unit_amount_usd:(x.price/100).toFixed(2),name:x.name})),
        amount_cents:selected.reduce((sum,x)=>sum+x.price*x.quantity,0)});
    }

    if (url.pathname === "/release" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {checkout_id?:unknown}|null;
      if (typeof body?.checkout_id!=="string" || !UUID.test(body.checkout_id)) return json({error:"invalid_checkout_id"},400);
      sql.exec("UPDATE inventory_reservations SET status='released' WHERE checkout_id=? AND status='active'",body.checkout_id);
      return json({ok:true});
    }

    if (url.pathname === "/commit" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {checkout_id?:unknown;payment_reference?:unknown;payment_method?:unknown}|null;
      const checkoutId=typeof body?.checkout_id==="string"?body.checkout_id:"";
      if (!UUID.test(checkoutId)) return json({error:"invalid_checkout_id"},400);
      const prior=sql.exec("SELECT status,expires_at FROM inventory_reservations WHERE checkout_id=?",checkoutId).toArray()[0] as {status:string;expires_at:string}|undefined;
      if (!prior) return json({error:"reservation_not_found"},404);
      const existing=sql.exec("SELECT order_id FROM inventory_orders WHERE checkout_id=?",checkoutId).toArray()[0] as {order_id:string}|undefined;
      if (existing) return json({ok:true,already_committed:true,order_id:existing.order_id});
      if (prior.status!=="active" || prior.expires_at<=now) { this.expireReservations(now); return json({error:"reservation_not_active"},409); }
      const items=sql.exec("SELECT product_id,quantity,unit_price_cents,name FROM inventory_reservation_items WHERE checkout_id=?",checkoutId).toArray() as Array<Record<string,unknown>>;
      if (!items.length) return json({error:"reservation_items_missing"},409);
      const orderId=crypto.randomUUID();
      const payload={order_id:orderId,checkout_id:checkoutId,
        items:items.map(x=>({product_id:x.product_id,quantity:x.quantity,unit_price_cents:x.unit_price_cents,name:x.name})),
        amount_cents:items.reduce((sum,x)=>sum+Number(x.unit_price_cents)*Number(x.quantity),0),
        payment_reference:typeof body?.payment_reference==="string"?body.payment_reference.slice(0,160):null,
        payment_method:typeof body?.payment_method==="string"?body.payment_method.slice(0,32):"unknown",status:"paid",created_at:now};
      try {
        this.ctx.storage.transactionSync(() => {
          for (const item of items) {
            const row=sql.exec("SELECT on_hand FROM inventory_catalog WHERE product_id=?",String(item.product_id)).toArray()[0] as {on_hand:number}|undefined;
            if (!row || Number(row.on_hand)<Number(item.quantity)) throw new Error("inventory_commit_conflict:" + String(item.product_id));
          }
          for (const item of items) sql.exec("UPDATE inventory_catalog SET on_hand=on_hand-? WHERE product_id=?",Number(item.quantity),String(item.product_id));
          sql.exec("UPDATE inventory_reservations SET status='committed' WHERE checkout_id=?",checkoutId);
          sql.exec("INSERT INTO inventory_orders(order_id,checkout_id,status,payload_json,created_at) VALUES(?,?,'pending_sync',?,?)",orderId,checkoutId,JSON.stringify(payload),now);
        });
      } catch (error) {
        const message=String(error);
        if (message.startsWith("inventory_commit_conflict:")) return json({error:"inventory_commit_conflict",product_id:message.split(":")[1]},409);
        throw error;
      }
      return json({ok:true,order_id:orderId,status:"pending_sync"});
    }

    if (url.pathname === "/offline/allocate" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {allocation_id?:unknown;allocations?:unknown;ttl_seconds?:unknown}|null;
      const allocationId=typeof body?.allocation_id==="string"?body.allocation_id:"";
      if (!UUID.test(allocationId)||!Array.isArray(body?.allocations)||body.allocations.length<1||body.allocations.length>100) return json({error:"invalid_allocations"},400);
      const allocations:Array<{id:string;quantity:number}>=[];
      for (const raw of body.allocations) {
        if (!raw||typeof raw!=="object") return json({error:"invalid_allocation"},400);
        const x=raw as Record<string,unknown>;
        if (typeof x.product_id!=="string"||!UUID.test(x.product_id)||!Number.isInteger(x.quantity)||Number(x.quantity)<1||Number(x.quantity)>10000) return json({error:"invalid_allocation"},400);
        allocations.push({id:x.product_id,quantity:Number(x.quantity)});
      }
      const combined=new Map<string,number>();
      for (const x of allocations) combined.set(x.id,(combined.get(x.id)??0)+x.quantity);
      allocations.length=0;
      for (const [id,quantity] of combined) allocations.push({id,quantity});
      const existing=sql.exec("SELECT status,expires_at FROM offline_allocations WHERE allocation_id=?",allocationId).toArray()[0] as {status:string;expires_at:string}|undefined;
      if (existing) {
        if (existing.status!=="active") return json({error:"offline_allocation_not_active",status:existing.status},409);
        const saved=sql.exec("SELECT product_id,allocated,remaining,unit_price_cents,name FROM offline_allocation_items WHERE allocation_id=? ORDER BY product_id",allocationId).toArray() as Array<{product_id:string;allocated:number;remaining:number;unit_price_cents:number;name:string}>;
        const same=saved.length===allocations.length&&saved.every(row=>allocations.some(item=>item.id===row.product_id&&item.quantity===Number(row.allocated)));
        if(!same)return json({error:"offline_allocation_id_conflict"},409);
        return json({ok:true,already_allocated:true,allocation_id:allocationId,expires_at:existing.expires_at,allocations:saved});
      }
      const ttlSeconds=Math.min(604800,Math.max(60,Number(body.ttl_seconds)||86400));
      const expiresAt=new Date(Date.parse(now)+ttlSeconds*1000).toISOString();
      let insufficient:string|null=null;
      const allocationDetails=new Map<string,{price_cents:number;name:string}>();
      this.ctx.storage.transactionSync(()=>{
        this.expireReservations(now);
        for(const x of allocations){
          const row=sql.exec("SELECT on_hand,offline_allocated,price_cents,name,COALESCE((SELECT SUM(i.quantity) FROM inventory_reservation_items i JOIN inventory_reservations r ON r.checkout_id=i.checkout_id WHERE i.product_id=inventory_catalog.product_id AND r.status='active'),0) AS reserved FROM inventory_catalog WHERE product_id=? AND status='active'",x.id).toArray()[0] as {on_hand:number;offline_allocated:number;price_cents:number;name:string;reserved:number}|undefined;
          if(!row||row.on_hand-row.offline_allocated-row.reserved<x.quantity){insufficient=x.id;return;}
          allocationDetails.set(x.id,{price_cents:Number(row.price_cents),name:String(row.name)});
        }
        sql.exec("INSERT INTO offline_allocations(allocation_id,status,created_at,expires_at) VALUES(?,'active',?,?)",allocationId,now,expiresAt);
        for(const x of allocations){
          const detail=allocationDetails.get(x.id);
          if(!detail)throw new Error("offline_allocation_detail_missing");
          sql.exec("UPDATE inventory_catalog SET offline_allocated=offline_allocated+? WHERE product_id=?",x.quantity,x.id);
          sql.exec("INSERT INTO offline_allocation_items(allocation_id,product_id,allocated,remaining,unit_price_cents,name) VALUES(?,?,?,?,?,?)",allocationId,x.id,x.quantity,x.quantity,detail.price_cents,detail.name);
        }
      });
      if(insufficient)return json({error:"insufficient_unallocated_stock",product_id:insufficient},409);
      const allocatedRows=sql.exec("SELECT product_id,allocated,remaining,unit_price_cents,name FROM offline_allocation_items WHERE allocation_id=? ORDER BY product_id",allocationId).toArray();
      return json({ok:true,allocation_id:allocationId,expires_at:expiresAt,allocations:allocatedRows});
    }

    if (url.pathname === "/offline/release" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {allocation_id?:unknown}|null;
      const allocationId=typeof body?.allocation_id==="string"?body.allocation_id:"";
      if(!UUID.test(allocationId))return json({error:"invalid_allocation_id"},400);
      const paymentMethod=typeof body.payment_method==="string"?body.payment_method.trim().toLowerCase():"offline_pos";
      if(!["offline_pos","cash","card","paypal","gift_card","other"].includes(paymentMethod))return json({error:"invalid_payment_method"},400);
      const paymentReference=typeof body.payment_reference==="string"?body.payment_reference.trim().slice(0,160):null;
      const allocation=sql.exec("SELECT status FROM offline_allocations WHERE allocation_id=?",allocationId).toArray()[0] as {status:string}|undefined;
      if(!allocation)return json({error:"offline_allocation_not_found"},404);
      if(allocation.status==="released")return json({ok:true,already_released:true});
      if(allocation.status!=="active")return json({ok:true,already_closed:true,status:allocation.status});
      this.ctx.storage.transactionSync(()=>{
        const rows=sql.exec("SELECT product_id,remaining FROM offline_allocation_items WHERE allocation_id=?",allocationId).toArray() as Array<{product_id:string;remaining:number}>;
        for(const row of rows){
          if(row.remaining>0)sql.exec("UPDATE inventory_catalog SET offline_allocated=MAX(0,offline_allocated-?) WHERE product_id=?",row.remaining,row.product_id);
          sql.exec("UPDATE offline_allocation_items SET remaining=0 WHERE allocation_id=? AND product_id=?",allocationId,row.product_id);
        }
        sql.exec("UPDATE offline_allocations SET status='released' WHERE allocation_id=?",allocationId);
      });
      return json({ok:true,released:true,allocation_id:allocationId});
    }

    if (url.pathname === "/offline/consume" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {allocation_id?:unknown;event_id?:unknown;order_id?:unknown;items?:unknown;payment_method?:unknown;payment_reference?:unknown}|null;
      const allocationId=typeof body?.allocation_id==="string"?body.allocation_id:"";
      const eventId=typeof body?.event_id==="string"?body.event_id:"";
      const orderId=typeof body?.order_id==="string"?body.order_id:"";
      if(!UUID.test(allocationId)||!UUID.test(eventId)||!UUID.test(orderId)||!Array.isArray(body?.items)||body.items.length<1||body.items.length>20)return json({error:"invalid_offline_sale"},400);
      const paymentMethod=typeof body.payment_method==="string"?body.payment_method.trim().toLowerCase():"offline_pos";
      if(!["offline_pos","cash","card","paypal","gift_card","other"].includes(paymentMethod))return json({error:"invalid_payment_method"},400);
      const paymentReference=typeof body.payment_reference==="string"?body.payment_reference.trim().slice(0,160):null;
      const prior=sql.exec("SELECT event_id,order_id FROM offline_sales WHERE event_id=?",eventId).toArray()[0] as {event_id:string;order_id:string}|undefined;
      if(prior)return prior.order_id===orderId?json({ok:true,duplicate:true,order_id:orderId}):json({error:"offline_event_id_conflict"},409);
      if(sql.exec("SELECT order_id FROM offline_sales WHERE order_id=?",orderId).toArray()[0]||sql.exec("SELECT order_id FROM inventory_orders WHERE order_id=?",orderId).toArray()[0])return json({error:"offline_order_already_recorded"},409);
      const requested=new Map<string,number>();
      for(const raw of body.items){
        if(!raw||typeof raw!=="object")return json({error:"invalid_inventory_item"},400);
        const x=raw as Record<string,unknown>;
        if(typeof x.product_id!=="string"||!UUID.test(x.product_id)||!Number.isInteger(x.quantity)||Number(x.quantity)<1||Number(x.quantity)>99)return json({error:"invalid_inventory_item"},400);
        requested.set(x.product_id,(requested.get(x.product_id)??0)+Number(x.quantity));
      }
      const allocation=sql.exec("SELECT status FROM offline_allocations WHERE allocation_id=?",allocationId).toArray()[0] as {status:string}|undefined;
      if(!allocation||allocation.status!=="active")return json({error:"offline_allocation_not_active"},409);
      const selected:Array<{product_id:string;quantity:number;unit_price_cents:number;name:string}>=[];
      for(const [productId,quantity] of requested){
        const allowance=sql.exec("SELECT remaining,unit_price_cents,name FROM offline_allocation_items WHERE allocation_id=? AND product_id=?",allocationId,productId).toArray()[0] as {remaining:number;unit_price_cents:number;name:string}|undefined;
        const row=sql.exec("SELECT offline_allocated,on_hand FROM inventory_catalog WHERE product_id=? AND status='active'",productId).toArray()[0] as {offline_allocated:number;on_hand:number}|undefined;
        if(!allowance||allowance.remaining<quantity||!row||row.offline_allocated<quantity||row.on_hand<quantity)return json({error:"offline_allowance_exceeded",product_id:productId},409);
        selected.push({product_id:productId,quantity,unit_price_cents:Number(allowance.unit_price_cents),name:String(allowance.name)});
      }
      const payload={order_id:orderId,allocation_id:allocationId,event_id:eventId,items:selected,amount_cents:selected.reduce((sum,x)=>sum+x.unit_price_cents*x.quantity,0),payment_method:paymentMethod,payment_reference:paymentReference,status:"paid_offline",created_at:now};
      let insufficient:string|null=null;
      try{
        this.ctx.storage.transactionSync(()=>{
          const current=sql.exec("SELECT status FROM offline_allocations WHERE allocation_id=?",allocationId).toArray()[0] as {status:string}|undefined;
          if(!current||current.status!=="active")throw new Error("offline_allocation_not_active");
          for(const item of selected){
            const allowance=sql.exec("SELECT remaining,unit_price_cents,name FROM offline_allocation_items WHERE allocation_id=? AND product_id=?",allocationId,item.product_id).toArray()[0] as {remaining:number;unit_price_cents:number;name:string}|undefined;
            const row=sql.exec("SELECT offline_allocated,on_hand FROM inventory_catalog WHERE product_id=?",item.product_id).toArray()[0] as {offline_allocated:number;on_hand:number}|undefined;
            if(!allowance||allowance.remaining<item.quantity||!row||row.offline_allocated<item.quantity||row.on_hand<item.quantity){insufficient=item.product_id;throw new Error("offline_allowance_conflict");}
          }
          for(const item of selected){
            sql.exec("UPDATE offline_allocation_items SET remaining=remaining-? WHERE allocation_id=? AND product_id=?",item.quantity,allocationId,item.product_id);
            sql.exec("UPDATE inventory_catalog SET offline_allocated=offline_allocated-?,on_hand=on_hand-? WHERE product_id=?",item.quantity,item.quantity,item.product_id);
          }
          sql.exec("UPDATE offline_allocations SET status='consumed' WHERE allocation_id=? AND NOT EXISTS (SELECT 1 FROM offline_allocation_items WHERE allocation_id=? AND remaining>0)",allocationId,allocationId);
          sql.exec("INSERT INTO offline_sales(event_id,order_id,payload_json,created_at) VALUES(?,?,?,?)",eventId,orderId,JSON.stringify(payload),now);
          sql.exec("INSERT INTO inventory_orders(order_id,checkout_id,status,payload_json,created_at) VALUES(?,?,'pending_sync',?,?)",orderId,"offline:"+orderId,JSON.stringify(payload),now);
        });
      }catch(error){
        if(String(error)==="Error: offline_allocation_not_active")return json({error:"offline_allocation_not_active"},409);
        if(insufficient)return json({error:"offline_allowance_exceeded",product_id:insufficient},409);
        throw error;
      }
      return json({ok:true,queued:true,order_id:orderId,status:"pending_sync"});
    }

    if (url.pathname === "/orders" && request.method === "GET") {
      const rows=sql.exec("SELECT order_id,payload_json,created_at FROM inventory_orders WHERE status='pending_sync' ORDER BY created_at LIMIT 250").toArray() as Array<{order_id:string;payload_json:string;created_at:string}>;
      return json({ok:true,orders:rows.map(x=>JSON.parse(x.payload_json)),count:rows.length});
    }
    if (url.pathname === "/orders/all" && request.method === "GET") {
      const rows=sql.exec("SELECT order_id,payload_json,status,created_at FROM inventory_orders ORDER BY created_at DESC LIMIT 250").toArray() as Array<{order_id:string;payload_json:string;status:string;created_at:string}>;
      return json({ok:true,orders:rows.map(x=>({...JSON.parse(x.payload_json),sync_status:x.status})),count:rows.length});
    }
    if (url.pathname === "/orders/ack" && request.method === "POST") {
      const body=await request.json().catch(()=>null) as {order_ids?:unknown}|null;
      if (!Array.isArray(body?.order_ids)||body.order_ids.length>250||body.order_ids.some(x=>typeof x!=="string"||!UUID.test(x))) return json({error:"invalid_order_ids"},400);
      for (const id of body.order_ids) sql.exec("UPDATE inventory_orders SET status='synced',acknowledged_at=? WHERE order_id=? AND status='pending_sync'",now,id);
      return json({ok:true,acknowledged:body.order_ids.length});
    }

    return json({error:"not_found"},404);
  }

  private expireOfflineAllocations(now:string) {
    const sql=this.ctx.storage.sql;
    const expired=sql.exec("SELECT allocation_id FROM offline_allocations WHERE status='active' AND expires_at<=?",now).toArray() as Array<{allocation_id:string}>;
    if(!expired.length)return;
    this.ctx.storage.transactionSync(()=>{
      for(const allocation of expired){
        const rows=sql.exec("SELECT product_id,remaining FROM offline_allocation_items WHERE allocation_id=?",allocation.allocation_id).toArray() as Array<{product_id:string;remaining:number}>;
        for(const row of rows){
          if(row.remaining>0)sql.exec("UPDATE inventory_catalog SET offline_allocated=MAX(0,offline_allocated-?) WHERE product_id=?",row.remaining,row.product_id);
          sql.exec("UPDATE offline_allocation_items SET remaining=0 WHERE allocation_id=? AND product_id=?",allocation.allocation_id,row.product_id);
        }
        sql.exec("UPDATE offline_allocations SET status='released' WHERE allocation_id=? AND status='active'",allocation.allocation_id);
      }
    });
  }

  private expireReservations(now:string) {
    this.ctx.storage.sql.exec("UPDATE inventory_reservations SET status='expired' WHERE status='active' AND expires_at<=?",now);
  }
}
