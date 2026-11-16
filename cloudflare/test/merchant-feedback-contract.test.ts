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
test("public feed requires explicit opt-in and exposes no private merchant identity",()=>{assert.match(durable,/public_consent=1/);assert.match(durable,/ALTER TABLE merchant_feedback ADD COLUMN public_consent/);assert.match(worker,/api\/merchant-feedback\/public/);assert.match(form,/Publish my review in the public feedback feed/);assert.match(form,/address, personal name, email and launch-interest choice will never appear/);assert.match(form,/id="publicReviews"/);});
test("Launchpad funding disclosure uses official branding and avoids promising an award",()=>{assert.match(form,/assets\/logo-1752\.png/);assert.match(form,/final interview stage for 1752vc/);assert.match(form,/\$1,000 refundable accountability fee/);assert.match(form,/up to \$100,000 in funding/);assert.match(form,/not a guarantee of investment/);assert.match(form,/has not endorsed, partnered with, or committed funding to Vampirequid/);});
test("admin controls are read/delete only",()=>{assert.match(admin,/Delete response/);assert.doesNotMatch(admin,/Edit response|Save changes/i);assert.match(durable,/request.method==="DELETE"/);assert.doesNotMatch(durable,/request.method==="PUT"/);});
