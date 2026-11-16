import { DurableObject } from "cloudflare:workers";
function json(data: unknown, status = 200): Response { return Response.json(data, { status, headers: { "cache-control": "no-store" } }); }
const clean=(v:unknown,n:number)=>typeof v==="string"?v.trim().slice(0,n):"";
export class MerchantFeedback extends DurableObject {
  private ensureSchema():void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS merchant_feedback (
      id TEXT PRIMARY KEY, store_name TEXT NOT NULL, address TEXT NOT NULL, contact_name TEXT NOT NULL,
      role TEXT NOT NULL, business_type TEXT NOT NULL, biggest_challenge TEXT NOT NULL,
      usefulness_rating INTEGER NOT NULL CHECK(usefulness_rating BETWEEN 1 AND 5),
      would_use TEXT NOT NULL CHECK(would_use IN ('yes','maybe','no')), honest_opinion TEXT NOT NULL,
      launch_interest INTEGER NOT NULL CHECK(launch_interest IN (0,1)), contact_email TEXT NOT NULL DEFAULT '',
      ip_hash TEXT NOT NULL, created_at TEXT NOT NULL)`);
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS merchant_feedback_created ON merchant_feedback(created_at DESC)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS merchant_feedback_ip_created ON merchant_feedback(ip_hash, created_at DESC)");
  }
  async fetch(request:Request):Promise<Response> {
    this.ensureSchema(); const url=new URL(request.url);
    if(url.pathname==="/submit"&&request.method==="POST"){
      const v=await request.json().catch(()=>null) as Record<string,unknown>|null;
      if(!v)return json({error:"invalid_json"},400);
      const store=clean(v.store_name,120),address=clean(v.address,240),contact=clean(v.contact_name,120),role=clean(v.role,20);
      const type=clean(v.business_type,80),challenge=clean(v.biggest_challenge,700),opinion=clean(v.honest_opinion,2500);
      const email=clean(v.contact_email,254),rating=Number(v.usefulness_rating),would=clean(v.would_use,10),ip=clean(request.headers.get("x-feedback-ip-hash"),64);
      if(store.length<2||address.length<5||contact.length<2||!["owner","manager"].includes(role)||type.length<2||challenge.length<10||
        !Number.isInteger(rating)||rating<1||rating>5||!["yes","maybe","no"].includes(would)||opinion.length<20||
        typeof v.launch_interest!=="boolean"||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return json({error:"please_complete_required_fields"},400);
      if(!/^[a-f0-9]{64}$/.test(ip))return json({error:"request_invalid"},400);
      const prior=this.ctx.storage.sql.exec("SELECT created_at,(SELECT COUNT(*) FROM merchant_feedback WHERE ip_hash=? AND created_at>=?) AS daily_count FROM merchant_feedback WHERE ip_hash=? ORDER BY created_at DESC LIMIT 1",
        ip,new Date(Date.now()-86400000).toISOString(),ip).toArray()[0] as {created_at?:string;daily_count?:number}|undefined;
      if(prior?.created_at&&Date.now()-Date.parse(prior.created_at)<45000)return json({error:"please_wait_before_submitting_again"},429);
      if(Number(prior?.daily_count??0)>=5)return json({error:"daily_submission_limit_reached"},429);
      const id=crypto.randomUUID(),created=new Date().toISOString();
      this.ctx.storage.sql.exec("INSERT INTO merchant_feedback (id,store_name,address,contact_name,role,business_type,biggest_challenge,usefulness_rating,would_use,honest_opinion,launch_interest,contact_email,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,store,address,contact,role,type,challenge,rating,would,opinion,v.launch_interest?1:0,email,ip,created);
      return json({ok:true,id,created_at:created},201);
    }
    if(url.pathname==="/list"&&request.method==="GET"){
      const rows=this.ctx.storage.sql.exec("SELECT id,store_name,address,contact_name,role,business_type,biggest_challenge,usefulness_rating,would_use,honest_opinion,launch_interest,contact_email,created_at FROM merchant_feedback ORDER BY created_at DESC LIMIT 500").toArray() as Array<Record<string,unknown>>;
      return json({ok:true,count:rows.length,submissions:rows.map(r=>({...r,launch_interest:Number(r.launch_interest)===1}))});
    }
    const match=url.pathname.match(/^\/([a-f0-9-]{36})$/);
    if(match&&request.method==="DELETE"){const result=this.ctx.storage.sql.exec("DELETE FROM merchant_feedback WHERE id=?",match[1]);return json({ok:true,deleted:result.rowsWritten>0});}
    return json({error:"not_found"},404);
  }
}