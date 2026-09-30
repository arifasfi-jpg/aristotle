import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
import { isDemoMode, razorpayConfigured } from '@/lib/payments';
import { getScopeRecord, payableError } from '@/lib/audit-meta';
export async function POST(req:Request){
 const user=await getCurrentUser(); if(!user)return NextResponse.json({error:'Session expired'},{status:401});
 const {auditId}=await req.json(); const audit=await db.audit.findFirst({where:{id:auditId,userId:user.id}}); if(!audit)return NextResponse.json({error:'Audit not found'},{status:404});
 if(audit.paymentStatus==='paid')return NextResponse.json({error:'This audit is already paid.'},{status:409});
 // Server-side gate: only a founder-confirmed NEW_IDEA / GROWTH_PLAN may be charged. OUT_OF_SCOPE never gets an order.
 const gate=payableError(await getScopeRecord(audit.id),{paymentRef:null}); if(gate.error)return NextResponse.json({error:gate.error},{status:403});
 if(isDemoMode())return NextResponse.json({demo:true,orderId:`demo_${audit.id}`,amount:audit.pricePaise,currency:'INR'});
 if(!razorpayConfigured()){console.error('Aristotle create-order: Razorpay keys are not configured');return NextResponse.json({error:'Payments are not configured right now. Please try again later.'},{status:503});}
 const rp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID!,key_secret:process.env.RAZORPAY_KEY_SECRET!});
 const order=await rp.orders.create({amount:audit.pricePaise,currency:'INR',receipt:audit.id});
 // Storing the order id freezes the confirmed scope (the scope route refuses changes once paymentRef is set).
 await db.audit.update({where:{id:audit.id},data:{paymentRef:order.id}});
 return NextResponse.json({demo:false,orderId:order.id,amount:order.amount,currency:order.currency,keyId:process.env.RAZORPAY_KEY_ID});// same key id the order was created with (a key id is public; the secret never leaves the server)
}
