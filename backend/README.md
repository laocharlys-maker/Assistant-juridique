# Aurore — Backend

Backend Node.js/Express/TypeScript. Porte l'orchestration metier et IA d'Aurore
(voir `../Aurore_Cahier_des_charges.md` pour l'architecture complete du projet
d'origine). La version desktop actuelle n'a plus de dependance a n8n : les
emails (documents, notifications, rappels) passent uniquement par SMTP/Brevo
(voir `services/mailer.ts`) ; WhatsApp et le lien Google Docs editable ont ete
retires du produit (voir README-LOT8TER.md).

## Demarrage (Phase 0)

1. Copier `.env.example` vers `.env` et renseigner `DATABASE_URL` (VPS Hostinger
   existant, ou base locale via `docker compose up -d` si vous preferez tester
   en local avant de pointer vers le VPS).
2. Installer les dependances :
   ```
   npm install
   ```
3. Appliquer le schema a la base :
   ```
   npm run prisma:migrate
   ```
4. Lancer le serveur en mode dev :
   ```
   npm run dev
   ```
5. Verifier : `GET http://localhost:3000/health` doit repondre
   `{ "status": "ok", "database": "connected" }`.

## Structure

```
src/
  config/     configuration (variables d'environnement validees via zod)
  lib/        clients partages (Prisma, etc.)
  middleware/ middlewares Express (auth, validation, ajoutes en Phase 2)
  routes/     endpoints HTTP
  services/   logique metier (extraction IA, validation, RAG, delais... a partir de la Phase 1)
prisma/
  schema.prisma  modele de donnees (cabinets, users, dossiers, actions, audit_logs, jurisprudence_chunks)
```

Le champ `embedding` de `jurisprudence_chunks` utilise l'extension PostgreSQL
`pgvector`, activee automatiquement par la migration Prisma.
