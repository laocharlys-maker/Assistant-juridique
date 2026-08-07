import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import { healthRouter } from "./routes/health";
import { authRouter } from "./routes/auth";
import { dossiersRouter } from "./routes/dossiers";
import { webActionsRouter } from "./routes/webActions";
import { usersRouter } from "./routes/users";
import { actionsCallbackRouter } from "./routes/actionsCallback";
import { commentairesRevisionRouter } from "./routes/commentairesRevision";
import { actionVersionsRouter } from "./routes/actionVersions";
import { actionsRedactionLibreRouter } from "./routes/actionsRedactionLibre";
import { clientsRouter } from "./routes/clients";
import { signatureRouter } from "./routes/signature";
import { jurisprudenceBaseRouter } from "./routes/jurisprudenceBase";
import { delaisRouter } from "./routes/delais";
import { statsRouter } from "./routes/stats";
import { documentExportRouter } from "./routes/documentExport";
import { cabinetRouter } from "./routes/cabinet";
import { facturesRouter } from "./routes/factures";
import { auditLogsRouter } from "./routes/auditLogs";
import { roleAudiencesRouter } from "./routes/roleAudiences";
import { huissiersRouter } from "./routes/huissiers";
import { adminRouter } from "./routes/admin";
import { licenceRouter } from "./routes/licence";
import { networkInfoRouter } from "./routes/networkInfo";
import { appInfoRouter } from "./routes/appInfo";
import { globalApiLimiter } from "./middleware/rateLimit";
import { requireLicence } from "./middleware/requireLicence";

export const app = express();

// Le backend est derriere un reverse proxy (Traefik) : sans ceci, toutes les
// requetes semblent venir de l'IP du proxy et le rate limiting par IP ne
// sert plus a rien.
app.set("trust proxy", 1);

// Compresse toutes les reponses (JSON API + HTML/CSS/JS statiques) -
// jusqu'ici aucune compression n'etait appliquee, ce qui alourdit chaque
// requete inutilement, en particulier sur des connexions lentes.
app.use(compression());

app.use(express.json({ limit: "15mb" }));
app.use("/api", globalApiLimiter);
app.use(cookieParser());
app.use(healthRouter);
app.use(licenceRouter);
// Lot 6 : toujours accessible, comme /api/licence/* - necessaire avant
// meme l'activation de licence (ecran de premier lancement, choix du mode
// de deploiement) et pour que les postes clients du reseau puissent lire
// l'IP/le nom d'hote du serveur.
app.use(networkInfoRouter);
// Lot 8 : "A propos" (numero de version) - meme raisonnement que
// network-info ci-dessus, information publique/non sensible.
app.use(appInfoRouter);
// A partir d'ici, toute route /api/* (sauf /api/licence/*, /api/network-info*
// et /health, deja servies ci-dessus) est bloquee si la licence locale est
// invalide/expiree au-dela de la periode de grace - voir
// middleware/requireLicence.ts et README-LOT3.md.
app.use(requireLicence);
app.use(authRouter);
app.use(dossiersRouter);
app.use(webActionsRouter);
app.use(usersRouter);
app.use(actionsCallbackRouter);
app.use(commentairesRevisionRouter);
app.use(actionVersionsRouter);
app.use(actionsRedactionLibreRouter);
app.use(clientsRouter);
app.use(signatureRouter);
app.use(jurisprudenceBaseRouter);
app.use(delaisRouter);
app.use(statsRouter);
app.use(documentExportRouter);
app.use(cabinetRouter);
app.use(facturesRouter);
app.use(auditLogsRouter);
app.use(roleAudiencesRouter);
app.use(huissiersRouter);
app.use(adminRouter);
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    // CSS/JS/images partages par toutes les pages (multi-pages, pas de SPA) :
    // sans cache, chaque navigation les retelecharge integralement. 5 minutes
    // suffit pour eviter ce cout pendant une session de travail, sans risquer
    // de servir une version perimee trop longtemps apres un deploiement. Les
    // pages HTML elles-memes restent non cachees (toujours revalidees) pour
    // qu'une mise a jour soit visible immediatement au prochain chargement.
    setHeaders: (res, filePath) => {
      if (!filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "public, max-age=300");
      }
    },
  })
);
