import { NativeModule, requireNativeModule } from "expo";

export interface PointPixel {
  x: number;
  y: number;
}

declare class ImageWarpModule extends NativeModule<{}> {
  /** coins : exactement 4 points, dans l'ordre haut-gauche, haut-droit,
   * bas-droit, bas-gauche, en coordonnees pixel de l'image source. Retourne
   * cheminDestination une fois l'image redressee ecrite. */
  redresser(cheminSource: string, coins: PointPixel[], cheminDestination: string): Promise<string>;
}

export default requireNativeModule<ImageWarpModule>("ImageWarp");
