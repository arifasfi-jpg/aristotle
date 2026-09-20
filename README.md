# Aristotle — transparent venture audit platform

A production-oriented Next.js application for Indian founders to submit a business idea, pay ₹99, receive an automated venture audit, and export their data/assets without lock-in.

## Stack
- Next.js App Router + TypeScript
- Tailwind CSS
- Prisma ORM + SQLite by default (switch `DATABASE_URL` to Postgres for production)
- OpenAI Responses API as an optional AI audit layer, with deterministic fallback
- Razorpay order + signature verification hooks
- JSZip for Lock-and-Barrel exports

## Local setup
1. `cp .env.example .env.local`
2. `npm install`
3. `npm run db:push`
4. `npm run dev`
5. Open http://localhost:3000

## Production
Use a managed Postgres database, HTTPS, a real email/identity provider, object storage for larger artifacts, and Razorpay production credentials. Set all secrets in the hosting provider. Run `npm run build` then `npm start`.

## Audit model
The audit engine intentionally distinguishes deterministic regulatory signals from legal advice. GST, MSME/Udyam, BIS and DPDP checks are surfaced as applicability prompts with source links. Regulatory rules should be reviewed before relying on the report for a launch decision.

## Pricing transparency
The platform fee is exactly 10% of the disclosed model compute estimate. The ₹99 audit fee is a separate customer charge. Model rates are environment-configurable so Aristotle never silently embeds an undisclosed token markup.
