import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { createSession } from '@/lib/session';
const schema=z.object({name:z.string().min(2).max(100),email:z.string().email(),idea:z.string().min(20).max(10000),sector:z.string(),stage:z.string(),geography:z.string().min(2).max(100),language:z.enum(['Simple English','Hinglish'])});
export async function POST(req:Request){try{const b=schema.parse(await req.json());const user=await db.user.upsert({where:{email:b.email.toLowerCase()},update:{name:b.name},create:{email:b.email.toLowerCase(),name:b.name}});await createSession(user.id);const audit=await db.audit.create({data:{userId:user.id,idea:b.idea,sector:b.sector,stage:b.stage,geography:b.geography,founderName:b.name,reportLanguage:b.language,assumptions:'[]',report:'{}',pricePaise:9900,paymentStatus:'pending'}});return NextResponse.json({id:audit.id,amount:9900,keyId:process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID||''});}catch(e:any){return NextResponse.json({error:e?.issues?.[0]?.message||e?.message||'Invalid request'},{status:400})}}
