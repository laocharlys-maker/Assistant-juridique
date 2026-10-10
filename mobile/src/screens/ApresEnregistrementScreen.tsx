import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import SelecteurDossier from "../components/SelecteurDossier";
import { envoyerElement } from "../sync/elements";
import { listerElementsLocaux, enregistrerElementLocal } from "../storage/db";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "ApresEnregistrement">;

/**
 * Après l'enregistrement (Prompt 4, objectif C) - le dossier (si pas déjà
 * choisi avant), un scan/une note optionnels (hors périmètre ici, prévu
 * Prompt 5), puis "Terminer" qui déclenche l'envoi. L'élément reste visible
 * dans "Mes éléments" tant qu'il n'est pas confirmé.
 */
export default function ApresEnregistrementScreen({ navigation, route }: Props) {
  const [dossierId, setDossierId] = useState<string | null>(route.params.dossierId);
  const [noteTexte, setNoteTexte] = useState("");
  const [envoiEnCours, setEnvoiEnCours] = useState(false);

  async function terminer() {
    setEnvoiEnCours(true);
    try {
      const elements = await listerElementsLocaux();
      const element = elements.find((e) => e.clientId === route.params.clientId);
      if (element) {
        element.dossierId = dossierId;
        element.noteTexte = noteTexte.trim() || null;
        await enregistrerElementLocal(element);
        envoyerElement(element).catch(() => {
          // Echec d'envoi immediat (reseau/Aurore injoignable) - l'element
          // reste "en_attente" et sera retente depuis "Mes elements".
        });
      }
      navigation.replace("MesElements");
    } catch {
      Alert.alert("Erreur", "Impossible d'enregistrer cet élément.");
    } finally {
      setEnvoiEnCours(false);
    }
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.titre}>Dossier</Text>
      <View style={styles.selecteur}>
        <SelecteurDossier dossierSelectionneId={dossierId} onSelection={setDossierId} />
      </View>

      <Text style={styles.titre}>Note (facultatif)</Text>
      <TextInput
        style={styles.note}
        value={noteTexte}
        onChangeText={setNoteTexte}
        placeholder="Quelques mots pour retrouver ce dossier…"
        placeholderTextColor="#5b6878"
        multiline
      />

      <Pressable style={styles.bouton} onPress={terminer} disabled={envoiEnCours}>
        <Text style={styles.boutonTexte}>Terminer</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  titre: { color: "#fff", fontSize: 15, fontWeight: "600", marginTop: 14, marginBottom: 8 },
  selecteur: { height: 260 },
  note: { borderWidth: 1, borderColor: "#2a3545", borderRadius: 10, padding: 12, color: "#fff", minHeight: 60 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 16, borderRadius: 12, alignItems: "center", marginTop: 20 },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
