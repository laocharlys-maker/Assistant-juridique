import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { healthRouter } from "./routes/health";
import { actionsRouter } from "./routes/actions";
import { authRouter } from "./routes/auth";
import { dossiersRouter } from "./routes/dossiers";
import { webActionsRouter } from "./routes/webActions";
import { usersRouter } from "./routes/users";
import { actionsCallbackRouter } from "./routes/actionsCallback";
import { clientsRouter } from "./routes/clients";
import { signatureRouter } from "./routes/signature";
import { jurisprudenceBaseRouter } from "./routes/jurisprudenceBase";
import { delaisRouter } from "./routes/delais";
import { statsRouter } from "./routes/stats";
import { documentExportRouter } from "./routes/documentExport";
import { cabinetRouter } from "./routes/cabinet";
import { facturesRouter } from "./routes/factures";
import { globalApiLimiter } from "./middleware/rateLimit";

export const app = express();

// Le backend est derriere un reverse proxy (Traefik) : sans ceci, toutes les
// requetes semblent venir de l'IP du proxy et le rate limiting par IP ne
// sert plus a rien.
app.set("trust proxy", 1);

app.use(express.json({ limit: "15mb" }));
app.use("/api", globalApiLimiter);
app.use(cookieParser());
app.use(healthRouter);
app.use(actionsRouter);
app.use(authRouter);
app.use(dossiersRouter);
app.use(webActionsRouter);
app.use(usersRouter);
app.use(actionsCallbackRouter);
app.use(clientsRouter);
app.use(signatureRouter);
app.use(jurisprudenceBaseRouter);
app.use(delaisRouter);
app.use(statsRouter);
app.use(documentExportRouter);
app.use(cabinetRouter);
app.use(facturesRouter);
app.use(express.static(path.join(__dirname, "..", "public")));
