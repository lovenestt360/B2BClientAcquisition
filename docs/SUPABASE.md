# Supabase database setup

This project uses Supabase only as hosted PostgreSQL. Authentication, authorization and application data access remain in the Next.js application and Prisma.

## Create the database

1. Create a Supabase project and keep its database password in a password manager.
2. In the Supabase dashboard, open **Connect** and copy both pooler connection strings.
3. Put the transaction-pooler string (port `6543`) in `DATABASE_URL`.
4. Put the session-pooler string (port `5432`) in `DIRECT_URL`.
5. Add `pgbouncer=true`, `connection_limit=10` and `sslmode=require` to `DATABASE_URL`.
6. Add `sslmode=require` to `DIRECT_URL`.

Example shapes (never commit real credentials):

```dotenv
DATABASE_URL="postgresql://postgres.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=10&sslmode=require"
DIRECT_URL="postgresql://postgres.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:5432/postgres?sslmode=require"
```

Percent-encode reserved characters in the password when placing it in a URL.

## Initialize

```bash
npx prisma generate
npx prisma migrate deploy
npm run db:seed
npm run dev
```

The migration and seed commands use `DIRECT_URL`; normal application queries use `DATABASE_URL`.

Keep simulation mode on and all real outreach gates disabled while validating the installation.
