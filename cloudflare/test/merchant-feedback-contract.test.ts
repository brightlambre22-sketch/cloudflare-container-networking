import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const root=new URL("../",import.meta.url);
const repoRoot=new URL("../../",import.meta.url);
const [worker,config,form,admin,durable]=await Promise.all([
 readFile(new URL("src/index.ts",root),"utf8"),readFile(new URL("wrangler.toml",root),"utf8"),
 readFile(new URL("public/merchant-feedback.html",repoRoot),"utf8"),
 readFile(new URL("public/merchant-feedback-admin.html",repoRoot),"utf8"),
 readFile(new URL("src/merchant-feedback.ts",root),"utf8")]);
test("feedback is stored in a SQLite Durable Object",()=>{assert.match(worker,/MerchantFeedback/);assert.match(config,/name = "MERCHANT_FEEDBACK"/);assert.match(durable,/CREATE TABLE IF NOT EXISTS merchant_feedback/);});
test("public form asks for store identity and an honest assessment",()=>{for(const s of ["Store \/ business name","Store address","Owner or manager name","Please give your honest opinion","name=\"launch_interest\""])assert.ok(form.includes(s),s);});
test("admin controls are read/delete only",()=>{assert.match(admin,/Delete response/);assert.doesNotMatch(admin,/Edit response|Save changes/i);assert.match(durable,/request.method==="DELETE"/);assert.doesNotMatch(durable,/request.method==="PUT"/);});
