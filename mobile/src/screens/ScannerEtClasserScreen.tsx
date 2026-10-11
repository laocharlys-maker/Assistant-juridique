import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import SelecteurDossier from "../components/SelecteurDossier";
import { terminerScan } from "../scan/scanner";
import { envoyerElement } from "../sync/elements";
import type { RootStackParamList } from "../navigation/RootNavigator";
import type { TypeScanLocal } from "../storage/db";

type Props = NativeStackScreenProps<RootStackParamList, "ScannerEtClasser">;

const TYPES_SCAN: { type: TypeScanLocal; label: string }[] = [
  { type: "piece", label: "📎 Pièce" },
  { type: "decision", label: "⚖️ Décision" },
  { type: "courrier", label: "✉️ Courrier" },
  { type: "convocation", label: "📅 Convocation" },
  { type: "autre", label: "📄 Autre" },
];

/**
 * "Scanner et classer" (Prompt 5, objectif B) - après le scan, un type en
 * un tap, puis le dossier (liste en cache) ou "à classer". Le type
 * "Courrier" est transmis tel quel à Aurore, qui crée le courrier "À
 * traiter" (voir backend/src/routes/mobileElements.ts, POST .../courrier -
 * côté Desktop, hors périmètre de cet écran).
 */
export default function ScannerEtClasserScreen({ navigation }: Props) {
  const [typeScan, setTypeScan] = useState<TypeScanLocal | null>(null);
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [envoiEnCours, setEnvoiEnCours] = useState(false);

  async function terminer() {
    if (!typeScan) {
      Alert.alert("Type manquant", "Choisis le type de document avant de continuer.");
      return;
    }
    setEnvoiEnCours(true);
    try {
      const element = await terminerScan({ dossierId, typeScan, noteTexte: null });
      envoyerElement(element).catch(() => {
        // Echec d'envoi immediat (reseau/Aurore injoignable) - l'element
        // reste "en_attente" et sera retente depuis "Mes elements".
      });
      navigation.replace("MesElements");
    } catch {
      Alert.alert("Erreur", "Impossible d'enregistrer ce scan.");
    } finally {
      setEnvoiEnCours(false);
    }
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.titre}>Type de document</Text>
      <View style={styles.grilleTypes}>
        {TYPES_SCAN.map((t) => (
          <Pressable
            key={t.type}
            style={[styles.boutonType, typeScan === t.type && styles.boutonTypeActif]}
            onPress={() => setTypeScan(t.type)}
          >
            <Text style={styles.boutonTypeTexte}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.titre}>Dossier</Text>
      <View style={styles.selecteur}>
        <SelecteurDossier dossierSelectionneId={dossierId} onSelection={setDossierId} />
      </View>

      <Pressable style={styles.bouton} onPress={terminer} disabled={envoiEnCours}>
        <Text style={styles.boutonTexte}>Terminer</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  titre: { color: "#fff", fontSize: 15, fontWeight: "600", marginTop: 14, marginBottom: 8 },
  grilleTypes: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  boutonType: { backgroundColor: "#141c2b", paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10 },
  boutonTypeActif: { borderWidth: 2, borderColor: "#3b82f6" },
  boutonTypeTexte: { color: "#fff", fontSize: 14 },
  selecteur: { height: 240 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 16, borderRadius: 12, alignItems: "center", marginTop: 20 },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
