import { NativeModule, requireNativeModule } from "expo";

declare class DeviceIntegrityModule extends NativeModule<{}> {
  /** Indices combinés (jamais un seul) - voir docs/lot10/07-securite.md
   * pour l'évaluation honnête de la fiabilité réelle (contournable par un
   * utilisateur déterminé, ex. Magisk Hide/Zygisk). */
  estAppareilProbablementDebride(): boolean;
}

export default requireNativeModule<DeviceIntegrityModule>("DeviceIntegrity");
