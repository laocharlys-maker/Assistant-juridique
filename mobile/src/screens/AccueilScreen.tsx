import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { testerConnexion } from "../pairing/appareil";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "Accueil">;

/**
 * Écran d'accueil (Prompt 3, objectif E). "Après audience" navigue vers un
 * écran d'attente : l'enregistrement audio réel arrive au Prompt 4, pas
 * construit ici - jamais présenté comme fonctionnel avant de l'être
 * réellement. Scanner/Note restent visuellement inactifs (Prompt 5).
 */
export default function AccueilScreen({ navigation }: Props) {
  const [connecte, setConnecte] = useState<boolean | null>(null);

  const verifierConnexion = useCallback(async () => {
    const ok = await testerConnexion();
    setConnecte(ok);
  }, []);

  useFocusEffect(
    useCallback(() => {
      verifierConnexion();
    }, [verifierConnexion])
  );

  useEffect(() => {
    const intervalle = setInterval(verifierConnexion, 15000);
    return () => clearInterval(intervalle);
  }, [verifierConnexion]);

  return (
    <View style={styles.conteneur}>
      <View style={styles.enTete}>
        <View style={[styles.pastille, { backgroundColor: connecte ? "#4ade80" : "#ef4444" }]} />
        <Text style={styles.texteEtat}>
          {connecte === null ? "Vérification…" : connecte ? "Connecté à Aurore" : "Aurore introuvable sur ce réseau"}
        </Text>
      </View>

      <Text style={styles.compteur}>0 élément en attente d’envoi</Text>

      <Pressable
        style={styles.boutonPrincipal}
        onPress={() =>
          Alert.alert(
            "Après audience",
            "L'enregistrement audio arrive dans une prochaine mise à jour d'Aurore Mobile."
          )
        }
      >
        <Text style={styles.boutonPrincipalTexte}>🎙️ Après audience</Text>
      </Pressable>

      <View style={styles.rangeeBoutons}>
        <Pressable style={styles.boutonInactif} disabled>
          <Text style={styles.boutonInactifTexte}>📄 Scanner</Text>
        </Pressable>
        <Pressable style={styles.boutonInactif} disabled>
          <Text style={styles.boutonInactifTexte}>📝 Note</Text>
        </Pressable>
      </View>

      <Pressable style={styles.boutonSecondaire} onPress={() => navigation.navigate("Dossiers")}>
        <Text style={styles.boutonSecondaireTexte}>Mes dossiers</Text>
      </Pressable>
      <Pressable style={styles.boutonSecondaire} onPress={() => navigation.navigate("Reglages")}>
        <Text style={styles.boutonSecondaireTexte}>Réglages</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, padding: 24, backgroundColor: "#0b1220" },
  enTete: { flexDirection: "row", alignItems: "center", marginTop: 40, marginBottom: 24 },
  pastille: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  texteEtat: { color: "#9aa5b1", fontSize: 13 },
  compteur: { color: "#fff", fontSize: 15, marginBottom: 32 },
  boutonPrincipal: {
    backgroundColor: "#3b82f6",
    paddingVertical: 28,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 20,
  },
  boutonPrincipalTexte: { color: "#fff", fontSize: 20, fontWeight: "700" },
  rangeeBoutons: { flexDirection: "row", gap: 12, marginBottom: 32 },
  boutonInactif: { flex: 1, backgroundColor: "#1a2332", paddingVertical: 18, borderRadius: 12, alignItems: "center" },
  boutonInactifTexte: { color: "#5b6878", fontSize: 15 },
  boutonSecondaire: { paddingVertical: 14, alignItems: "center" },
  boutonSecondaireTexte: { color: "#9aa5b1", fontSize: 15 },
});
