import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import SelecteurDossier from "../components/SelecteurDossier";
import { demarrerEnregistrement, PermissionMicrophoneRefuseeError, reinitialiserSession } from "../audio/recorder";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "ApresAudience">;

/**
 * "Après audience" (Prompt 4, objectif C) - le dossier peut être choisi ici
 * OU après l'enregistrement (voir ApresEnregistrementScreen) : jamais
 * obligatoire à ce stade, pour ne jamais retarder le démarrage.
 */
export default function ApresAudienceScreen({ navigation }: Props) {
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [demarrage, setDemarrage] = useState(false);
  const insets = useSafeAreaInsets();

  async function demarrer() {
    setDemarrage(true);
    try {
      await demarrerEnregistrement();
      navigation.replace("Enregistrement", { dossierId });
    } catch (erreur) {
      if (erreur instanceof PermissionMicrophoneRefuseeError) {
        Alert.alert(
          "Permission refusée",
          "Aurore Mobile a besoin du micro pour enregistrer. Autorise-le dans les réglages du téléphone."
        );
      } else if (erreur instanceof Error && erreur.message === "ENREGISTREMENT_DEJA_EN_COURS") {
        // Une session precedente n'a pas ete correctement terminee (ecran
        // quitte de force, crash...) - on la reinitialise et on reessaie
        // immediatement, plutot que de laisser l'utilisateur bloque.
        reinitialiserSession();
        Alert.alert("Nouvelle tentative", "Une session précédente a été nettoyée, réessaie.");
      } else {
        Alert.alert("Erreur", "Impossible de démarrer l'enregistrement.");
      }
    } finally {
      setDemarrage(false);
    }
  }

  return (
    <View style={[styles.conteneur, { paddingBottom: Math.max(16, insets.bottom) }]}>
      <Text style={styles.titre}>Choisir le dossier (facultatif)</Text>
      <SelecteurDossier dossierSelectionneId={dossierId} onSelection={setDossierId} />
      <Pressable style={styles.bouton} onPress={demarrer} disabled={demarrage}>
        <Text style={styles.boutonTexte}>🎙️ Commencer l’enregistrement</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  titre: { color: "#fff", fontSize: 16, fontWeight: "600", marginVertical: 10 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 18, borderRadius: 14, alignItems: "center", marginTop: 12 },
  boutonTexte: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
