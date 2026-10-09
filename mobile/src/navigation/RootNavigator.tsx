import React from "react";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AppairageScreen from "../screens/AppairageScreen";
import AccueilScreen from "../screens/AccueilScreen";
import DossiersScreen from "../screens/DossiersScreen";
import ReglagesScreen from "../screens/ReglagesScreen";
import SpikeAudioScreen from "../screens/SpikeAudioScreen";

export type RootStackParamList = {
  Appairage: undefined;
  Accueil: undefined;
  Dossiers: undefined;
  Reglages: undefined;
  SpikeAudio: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/** Écran initial décidé par App.tsx (Appairage si jamais appairé, Accueil
 * sinon) - voir son prop `initialRouteName`. */
export default function RootNavigator({ ecranInitial }: { ecranInitial: keyof RootStackParamList }) {
  return (
    <Stack.Navigator initialRouteName={ecranInitial} screenOptions={{ headerStyle: { backgroundColor: "#0b1220" }, headerTintColor: "#fff" }}>
      <Stack.Screen name="Appairage" options={{ title: "Connecter à Aurore", headerBackVisible: false }}>
        {({ navigation }) => <AppairageScreen onAppaire={() => navigation.replace("Accueil")} />}
      </Stack.Screen>
      <Stack.Screen name="Accueil" component={AccueilScreen} options={{ title: "Aurore Mobile", headerBackVisible: false }} />
      <Stack.Screen name="Dossiers" component={DossiersScreen} options={{ title: "Mes dossiers" }} />
      <Stack.Screen name="Reglages" component={ReglagesScreen} options={{ title: "Réglages" }} />
      <Stack.Screen name="SpikeAudio" component={SpikeAudioScreen} options={{ title: "Spike audio (test interne)" }} />
    </Stack.Navigator>
  );
}
