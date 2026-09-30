import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession, getCurrentUser } from '@/lib/session';
const schema=z.object({name:z.string().min(2).max(100),email:z.string().email(),idea:z.string().min(20).max(10000),sector:z.string(),stage:z.string(),geography:z.string().min(2).max(100),language:z.enum(['Simple English','Hinglish'])});
export async function POST(req:Request){try{const b=schema.parse(await req.json());
 // SECURITY: identity comes ONLY from an existing valid session. The typed email is contact information,
 // never proof of identity: it is not used to look up, log into, or modify any existing account.
 let user=await getCurrentUser();
 if(!user){user=await db.user.create({data:{name:b.name}});await createSession(user.id);}
 const audit=await db.audit.create({data:{userId:user.id,idea:b.idea,sector:b.sector,stage:b.stage,geography:b.geography,founderName:b.name,contactEmail:b.email.toLowerCase(),reportLanguage:b.language,assumptions:'[]',report:'{}',pricePaise:9900,paymentStatus:'pending'}});return NextResponse.json({id:audit.id,amount:9900,keyId:process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID||''});}catch(e:any){return NextResponse.json({error:e?.issues?.[0]?.message||e?.message||'Invalid request'},{status:400})}}
