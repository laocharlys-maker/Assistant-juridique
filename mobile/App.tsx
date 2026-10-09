import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, AppStateStatus, View, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as ScreenCapture from "expo-screen-capture";
import RootNavigator from "./src/navigation/RootNavigator";
import VerrouillageScreen from "./src/screens/VerrouillageScreen";
import { doitSeVerrouiller } from "./src/lock/lock";
import { estAppaire } from "./src/pairing/appareil";

/**
 * Racine de l'app (Prompt 3) - porte de verrouillage : RIEN d'autre ne
 * s'affiche avant déverrouillage (critère d'acceptation explicite du
 * plan). Empêche aussi les captures d'écran tant que l'app est
 * déverrouillée (objectif C).
 */
export default function App() {
  const [verrouille, setVerrouille] = useState(true);
  const [ecranInitial, setEcranInitial] = useState<"Appairage" | "Accueil" | null>(null);
  const horodatageArrierePlan = useRef<number | null>(null);

  useEffect(() => {
    estAppaire().then((appaire) => setEcranInitial(appaire ? "Accueil" : "Appairage"));
  }, []);

  useEffect(() => {
    if (verrouille) {
      ScreenCapture.allowScreenCaptureAsync().catch(() => undefined);
    } else {
      ScreenCapture.preventScreenCaptureAsync().catch(() => undefined);
    }
  }, [verrouille]);

  const surChangementEtat = useCallback(async (etat: AppStateStatus) => {
    if (etat === "background" || etat === "inactive") {
      horodatageArrierePlan.current = Date.now();
      return;
    }
    if (etat === "active" && horodatageArrierePlan.current !== null) {
      const doitVerrouiller = await doitSeVerrouiller(horodatageArrierePlan.current);
      horodatageArrierePlan.current = null;
      if (doitVerrouiller) setVerrouille(true);
    }
  }, []);

  useEffect(() => {
    const abonnement = AppState.addEventListener("change", surChangementEtat);
    return () => abonnement.remove();
  }, [surChangementEtat]);

  if (ecranInitial === null) {
    return <View style={styles.fond} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {verrouille ? (
        <VerrouillageScreen onDeverrouille={() => setVerrouille(false)} />
      ) : (
        <NavigationContainer>
          <RootNavigator ecranInitial={ecranInitial} />
        </NavigationContainer>
      )}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fond: { flex: 1, backgroundColor: "#0b1220" },
});
