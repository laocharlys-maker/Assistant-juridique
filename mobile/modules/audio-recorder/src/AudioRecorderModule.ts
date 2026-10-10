import { NativeModule, requireNativeModule } from "expo";

export type SegmentTermine = {
  chemin: string;
  dureeMs: number;
  numero: number;
};

type EtatEnregistrement = {
  enCours: boolean;
  enPause: boolean;
  derniereErreur: string | null;
};

declare class AudioRecorderModule extends NativeModule<{}> {
  demarrer(dossierSegments: string, dureeSegmentMs: number): void;
  mettreEnPause(): void;
  reprendre(): void;
  arreter(): void;
  niveauSonore(): number;
  recupererSegmentsTermines(): SegmentTermine[];
  etat(): EtatEnregistrement;
}

export default requireNativeModule<AudioRecorderModule>("AudioRecorder");
