# Production deployment checklist

## Database
Set `DATABASE_URL` to a managed PostgreSQL connection string and change the Prisma datasource provider to `postgresql` before applying migrations.

## Payments
Set Razorpay production credentials:
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `NEXT_PUBLIC_RAZORPAY_KEY_ID`

The server verifies Razorpay signatures before changing an audit from pending to paid.

## AI
Set `OPENAI_API_KEY` and `OPENAI_MODEL`. The default is `gpt-5.6-luna`. Model input/output prices are separately configured with `MODEL_INPUT_USD_PER_MILLION` and `MODEL_OUTPUT_USD_PER_MILLION`; `USD_INR` controls the disclosed conversion. Aristotle applies exactly 10% to the resulting compute estimate.

## Security hardening before public launch
- Add email OTP / SSO instead of email-only session bootstrap.
- Add rate limiting/WAF on audit and payment endpoints.
- Add CAPTCHA/bot protection around the paid flow.
- Move large generated artifacts to encrypted object storage.
- Add structured audit logs and error monitoring.
- Maintain a reviewed regulatory ruleset with effective dates and source URLs.
- Add a webhook handler for payment reconciliation and refunds.
