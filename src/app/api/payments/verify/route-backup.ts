import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { runAudit } from '@/lib/ai';
export async function POST(req:Request){
 const user=await getCurrentUser(); if(!user)return NextResponse.json({error:'Session expired'},{status:401});
 const b=await req.json(); const audit=await db.audit.findFirst({where:{id:b.auditId,userId:user.id}}); if(!audit)return NextResponse.json({error:'Audit not found'},{status:404});
 if(!b.demo){const expected=crypto.createHmac('sha256',process.env.RAZORPAY_KEY_SECRET||'').update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');if(expected!==b.razorpay_signature)return NextResponse.json({error:'Payment verification failed'},{status:400});}
 const result=await runAudit({idea:audit.idea,sector:audit.sector as any,stage:audit.stage||undefined,geography:audit.geography||'India',language:(audit.reportLanguage as any)||'Simple English'});
 await db.audit.update({where:{id:audit.id},data:{paymentStatus:'paid',paymentRef:b.razorpay_payment_id||audit.paymentRef,report:JSON.stringify(result.report),assumptions:JSON.stringify(result.report.assumptions),computePaise:Math.round(result.pricing.computeInr*100),marginPaise:Math.round(result.pricing.marginInr*100),status:'completed'}});
 await db.projectFile.upsert({where:{auditId_path:{auditId:audit.id,path:'audit.json'}},update:{content:JSON.stringify({auditId:audit.id,idea:audit.idea,sector:audit.sector,report:result.report,pricing:result.pricing},null,2)},create:{auditId:audit.id,path:'audit.json',content:JSON.stringify({auditId:audit.id,idea:audit.idea,sector:audit.sector,report:result.report,pricing:result.pricing},null,2)}});
 await db.projectFile.upsert({where:{auditId_path:{auditId:audit.id,path:'README.md'}},update:{content:`# Aristotle export\n\nAudit ID: ${audit.id}\n\nPortable audit bundle. No proprietary database format is required.`},create:{auditId:audit.id,path:'README.md',content:`# Aristotle export\n\nAudit ID: ${audit.id}\n\nPortable audit bundle. No proprietary database format is required.`}});
 return NextResponse.json({ok:true});
}
