import { NativeModule, requireNativeModule } from "expo";

type EtatSpike = {
  enCours: boolean;
  demarreA: number;
  derniereErreur: string | null;
};

declare class AudioSpikeModule extends NativeModule<{}> {
  demarrer(cheminAudio: string, cheminHeartbeat: string): void;
  arreter(): void;
  etat(): EtatSpike;
}

export default requireNativeModule<AudioSpikeModule>("AudioSpike");
