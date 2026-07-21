import express from "express";
import cookieParser from "cookie-parser";
import { healthRouter } from "./routes/health";
import { actionsRouter } from "./routes/actions";
import { authRouter } from "./routes/auth";
import { dossiersRouter } from "./routes/dossiers";

export const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(healthRouter);
app.use(actionsRouter);
app.use(authRouter);
app.use(dossiersRouter);
