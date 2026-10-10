import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { listerElementsLocaux, supprimerElementLocal, type ElementLocal } from "../storage/db";
import { reconstituerAudioClair, supprimerSegmentsLocaux } from "../audio/recorder";
import { envoyerElementsEnAttente, verifierConfirmations } from "../sync/elements";

const LIBELLE_STATUT: Record<ElementLocal["statut"], string> = {
  en_attente: "En attente d’envoi",
  envoye: "Envoyé, en attente de confirmation",
  confirme: "Confirmé par Aurore",
};

/**
 * "Mes éléments" (Prompt 4, objectif D) - un élément n'est supprimable du
 * téléphone qu'une fois confirmé par Aurore, jamais avant (contrainte
 * explicite du prompt).
 */
export default function MesElementsScreen() {
  const [elements, setElements] = useState<ElementLocal[]>([]);
  const player = useAudioPlayer();

  const charger = useCallback(async () => {
    setElements(await listerElementsLocaux());
  }, []);

  useFocusEffect(
    useCallback(() => {
      let annule = false;
      (async () => {
        await charger();
        await envoyerElementsEnAttente();
        await verifierConfirmations();
        if (!annule) await charger();
      })();
      return () => {
        annule = true;
      };
    }, [charger])
  );

  async function reecouter(element: ElementLocal) {
    try {
      const audio = await reconstituerAudioClair(element.clientId, element.nombreSegments);
      const fichierTemp = new File(Paths.cache, `ecoute-${element.clientId}.aac`);
      if (fichierTemp.exists) fichierTemp.delete();
      fichierTemp.create();
      fichierTemp.write(audio);
      player.replace({ uri: fichierTemp.uri });
      player.play();
    } catch {
      Alert.alert("Erreur", "Impossible de relire cet enregistrement.");
    }
  }

  function supprimer(element: ElementLocal) {
    if (element.statut !== "confirme") return;
    Alert.alert("Supprimer cet élément ?", "Il a déjà été confirmé par Aurore.", [
      { text: "Annuler", style: "cancel" },
      {
        text: "Supprimer",
        style: "destructive",
        onPress: async () => {
          supprimerSegmentsLocaux(element.clientId);
          await supprimerElementLocal(element.clientId);
          await charger();
        },
      },
    ]);
  }

  return (
    <View style={styles.conteneur}>
      <FlatList
        data={elements}
        keyExtractor={(item) => item.clientId}
        onRefresh={charger}
        refreshing={false}
        ListEmptyComponent={<Text style={styles.vide}>Aucun élément pour l’instant.</Text>}
        renderItem={({ item }) => (
          <View style={styles.ligne}>
            <Text style={styles.duree}>{Math.round(item.dureeSecondes / 60)} min</Text>
            <Text style={styles.statut}>{LIBELLE_STATUT[item.statut]}</Text>
            {item.noteTexte && <Text style={styles.note}>{item.noteTexte}</Text>}
            <View style={styles.actions}>
              <Pressable style={styles.boutonAction} onPress={() => reecouter(item)}>
                <Text style={styles.boutonActionTexte}>▶ Réécouter</Text>
              </Pressable>
              {item.statut === "confirme" && (
                <Pressable style={[styles.boutonAction, styles.boutonSuppression]} onPress={() => supprimer(item)}>
                  <Text style={styles.boutonActionTexte}>Supprimer</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  vide: { color: "#5b6878", textAlign: "center", marginTop: 40 },
  ligne: { backgroundColor: "#141c2b", borderRadius: 10, padding: 14, marginBottom: 10 },
  duree: { color: "#fff", fontSize: 16, fontWeight: "600" },
  statut: { color: "#9aa5b1", fontSize: 13, marginTop: 4 },
  note: { color: "#9aa5b1", fontSize: 13, marginTop: 4, fontStyle: "italic" },
  actions: { flexDirection: "row", gap: 10, marginTop: 10 },
  boutonAction: { backgroundColor: "#3b82f6", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  boutonSuppression: { backgroundColor: "#7f1d1d" },
  boutonActionTexte: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
