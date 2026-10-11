import React, { useCallback, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, FlatList } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import SelecteurDossier from "../components/SelecteurDossier";
import { creerNoteLocale, joindreNoteAElement, NoteVideError } from "../notes/notes";
import { envoyerElement } from "../sync/elements";
import { listerElementsLocaux, type ElementLocal } from "../storage/db";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "NoteTexte">;

const LIBELLE_TYPE: Record<ElementLocal["type"], string> = {
  audio: "🎙️ Audio",
  scan: "📄 Scan",
  note: "📝 Note",
};

/**
 * Note texte rapide (Prompt 5, objectif C) - rattachée à un dossier (ou "à
 * classer") comme un nouvel élément, OU jointe à un élément déjà créé mais
 * pas encore envoyé (audio ou scan) via `joindreNoteAElement`.
 */
export default function NoteTexteScreen({ navigation }: Props) {
  const [mode, setMode] = useState<"nouvelle" | "joindre">("nouvelle");
  const [texte, setTexte] = useState("");
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [elementsEnAttente, setElementsEnAttente] = useState<ElementLocal[]>([]);
  const [clientIdCible, setClientIdCible] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useFocusEffect(
    useCallback(() => {
      listerElementsLocaux().then((elements) =>
        setElementsEnAttente(elements.filter((e) => e.statut === "en_attente"))
      );
    }, [])
  );

  async function valider() {
    setEnCours(true);
    try {
      if (mode === "joindre") {
        if (!clientIdCible) {
          Alert.alert("Choisis un élément", "Sélectionne l'élément auquel joindre cette note.");
          return;
        }
        await joindreNoteAElement(clientIdCible, texte);
        navigation.replace("MesElements");
        return;
      }

      const element = await creerNoteLocale(texte, dossierId);
      envoyerElement(element).catch(() => {
        // Echec d'envoi immediat - l'element reste "en_attente" et sera
        // retente depuis "Mes elements".
      });
      navigation.replace("MesElements");
    } catch (erreur) {
      if (erreur instanceof NoteVideError) {
        Alert.alert("Note vide", "Écris quelque chose avant de valider.");
      } else {
        Alert.alert("Erreur", "Impossible d'enregistrer cette note.");
      }
    } finally {
      setEnCours(false);
    }
  }

  return (
    <View style={styles.conteneur}>
      <View style={styles.rangeeModes}>
        <Pressable
          style={[styles.boutonMode, mode === "nouvelle" && styles.boutonModeActif]}
          onPress={() => setMode("nouvelle")}
        >
          <Text style={styles.boutonModeTexte}>Nouvelle note</Text>
        </Pressable>
        <Pressable
          style={[styles.boutonMode, mode === "joindre" && styles.boutonModeActif]}
          onPress={() => setMode("joindre")}
        >
          <Text style={styles.boutonModeTexte}>Joindre à un élément</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.texte}
        value={texte}
        onChangeText={setTexte}
        placeholder="Écris ta note ici…"
        placeholderTextColor="#5b6878"
        multiline
        autoFocus
      />

      {mode === "nouvelle" ? (
        <>
          <Text style={styles.titre}>Dossier</Text>
          <View style={styles.selecteur}>
            <SelecteurDossier dossierSelectionneId={dossierId} onSelection={setDossierId} />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.titre}>Élément en attente</Text>
          <FlatList
            style={styles.liste}
            data={elementsEnAttente}
            keyExtractor={(item) => item.clientId}
            ListEmptyComponent={<Text style={styles.vide}>Aucun élément en attente pour l’instant.</Text>}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.ligneElement, clientIdCible === item.clientId && styles.ligneElementActive]}
                onPress={() => setClientIdCible(item.clientId)}
              >
                <Text style={styles.ligneElementTexte}>
                  {LIBELLE_TYPE[item.type]} — {new Date(item.creeLe).toLocaleString("fr-FR")}
                </Text>
              </Pressable>
            )}
          />
        </>
      )}

      <Pressable style={styles.bouton} onPress={valider} disabled={enCours}>
        <Text style={styles.boutonTexte}>Valider</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  rangeeModes: { flexDirection: "row", gap: 10 },
  boutonMode: { flex: 1, backgroundColor: "#141c2b", paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  boutonModeActif: { borderWidth: 2, borderColor: "#3b82f6" },
  boutonModeTexte: { color: "#fff", fontSize: 13 },
  titre: { color: "#fff", fontSize: 15, fontWeight: "600", marginTop: 14, marginBottom: 8 },
  texte: {
    borderWidth: 1,
    borderColor: "#2a3545",
    borderRadius: 10,
    padding: 12,
    color: "#fff",
    minHeight: 100,
    marginTop: 14,
  },
  selecteur: { height: 240 },
  liste: { maxHeight: 240 },
  vide: { color: "#5b6878", textAlign: "center", marginTop: 20 },
  ligneElement: { backgroundColor: "#141c2b", borderRadius: 10, padding: 12, marginBottom: 8 },
  ligneElementActive: { borderWidth: 2, borderColor: "#3b82f6" },
  ligneElementTexte: { color: "#fff", fontSize: 14 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 16, borderRadius: 12, alignItems: "center", marginTop: 20 },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
