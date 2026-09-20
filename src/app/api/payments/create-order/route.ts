import { NextResponse } from 'next/server';
import Razorpay from 'razorpay';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/session';
export async function POST(req:Request){
 const user=await getCurrentUser(); if(!user)return NextResponse.json({error:'Session expired'},{status:401});
 const {auditId}=await req.json(); const audit=await db.audit.findFirst({where:{id:auditId,userId:user.id}}); if(!audit)return NextResponse.json({error:'Audit not found'},{status:404});
 if(!process.env.RAZORPAY_KEY_ID||!process.env.RAZORPAY_KEY_SECRET)return NextResponse.json({demo:true,orderId:`demo_${audit.id}`,amount:audit.pricePaise,currency:'INR'});
 const rp=new Razorpay({key_id:process.env.RAZORPAY_KEY_ID,key_secret:process.env.RAZORPAY_KEY_SECRET});
 const order=await rp.orders.create({amount:audit.pricePaise,currency:'INR',receipt:audit.id});
 await db.audit.update({where:{id:audit.id},data:{paymentRef:order.id}});
 return NextResponse.json({demo:false,orderId:order.id,amount:order.amount,currency:order.currency,keyId:process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID});
}
