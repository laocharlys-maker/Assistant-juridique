import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { listerElementsLocaux, supprimerElementLocal, type ElementLocal } from "../storage/db";
import { reconstituerAudioClair, supprimerSegmentsLocaux } from "../audio/recorder";
import { supprimerScanLocal } from "../scan/scanner";
import { envoyerElementsEnAttente, verifierConfirmations, compterElementsEnAttente } from "../sync/elements";

const LIBELLE_STATUT: Record<ElementLocal["statut"], string> = {
  en_attente: "En attente d’envoi",
  en_cours: "Envoi en cours…",
  envoye: "Envoyé, en attente de confirmation",
  confirme: "Confirmé par Aurore",
  en_erreur: "Échec d’envoi",
};

const LIBELLE_TYPE_SCAN: Record<NonNullable<ElementLocal["typeScan"]>, string> = {
  piece: "Pièce",
  decision: "Décision",
  courrier: "Courrier",
  convocation: "Convocation",
  autre: "Autre",
};

/** Ligne d'en-tête affichée pour chaque élément - spécifique au type
 * (Prompt 5 : scan et note n'ont ni durée ni segments, contrairement à
 * l'audio du Prompt 4). */
function libelleEntete(element: ElementLocal): string {
  if (element.type === "audio") return `🎙️ ${Math.round((element.dureeSecondes ?? 0) / 60)} min`;
  if (element.type === "scan") {
    const nombrePages = element.nombrePages ?? 0;
    const typeLabel = element.typeScan ? LIBELLE_TYPE_SCAN[element.typeScan] : "";
    return `📄 ${nombrePages} page${nombrePages > 1 ? "s" : ""}${typeLabel ? " — " + typeLabel : ""}`;
  }
  return "📝 Note";
}

function formaterSecondes(secondes: number): string {
  const s = Math.max(0, Math.floor(secondes));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * "Mes éléments" (Prompt 4, objectif D) - un élément n'est supprimable du
 * téléphone qu'une fois confirmé par Aurore, jamais avant (contrainte
 * explicite du prompt). Un seul lecteur partagé pour tout l'écran : une
 * seule réécoute à la fois a du sens ici.
 */
export default function MesElementsScreen() {
  const [elements, setElements] = useState<ElementLocal[]>([]);
  const [clientIdEnLecture, setClientIdEnLecture] = useState<string | null>(null);
  const player = useAudioPlayer();
  const statutLecture = useAudioPlayerStatus(player);

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

  async function basculerLecture(element: ElementLocal) {
    if (element.type !== "audio") return;
    if (clientIdEnLecture === element.clientId) {
      if (statutLecture.playing) {
        player.pause();
      } else {
        player.play();
      }
      return;
    }

    try {
      const audio = await reconstituerAudioClair(element.clientId, element.nombreSegments ?? 0);
      const fichierTemp = new File(Paths.cache, `ecoute-${element.clientId}.aac`);
      if (fichierTemp.exists) fichierTemp.delete();
      fichierTemp.create();
      fichierTemp.write(audio);
      player.replace({ uri: fichierTemp.uri });
      player.play();
      setClientIdEnLecture(element.clientId);
    } catch {
      Alert.alert("Erreur", "Impossible de relire cet enregistrement.");
    }
  }

  function peutSupprimer(element: ElementLocal): boolean {
    if (element.statut === "confirme") return true;
    // Prompt 6, objectif E : un echec PERMANENT (appareil revoque,
    // enregistrement vide...) ne sera jamais envoye - rien a perdre cote
    // serveur, l'utilisateur doit pouvoir s'en debarrasser. nombreSegments
    // === 0 reste gardee pour les tres rares elements crees avant ce
    // correctif (pas encore marques echecPermanent).
    if (element.echecPermanent) return true;
    if (element.type === "audio" && element.nombreSegments === 0) return true;
    return false;
  }

  function nettoyerFichiersLocaux(element: ElementLocal) {
    if (element.type === "audio") supprimerSegmentsLocaux(element.clientId);
    else if (element.type === "scan") supprimerScanLocal(element.clientId);
  }

  function supprimer(element: ElementLocal) {
    if (!peutSupprimer(element)) return;
    const message =
      element.statut === "confirme" ? "Il a déjà été confirmé par Aurore." : "Il ne pourra jamais être envoyé à Aurore.";
    Alert.alert("Supprimer cet élément ?", message, [
      { text: "Annuler", style: "cancel" },
      {
        text: "Supprimer",
        style: "destructive",
        onPress: async () => {
          nettoyerFichiersLocaux(element);
          await supprimerElementLocal(element.clientId);
          await charger();
        },
      },
    ]);
  }

  const enAttente = compterElementsEnAttente(elements);

  return (
    <View style={styles.conteneur}>
      {/* Prompt 6, objectif A - compteur visible (ici et sur l'accueil). */}
      <Text style={styles.compteur}>
        {enAttente} élément{enAttente === 1 ? "" : "s"} en attente
      </Text>
      <FlatList
        data={elements}
        keyExtractor={(item) => item.clientId}
        onRefresh={charger}
        refreshing={false}
        ListEmptyComponent={<Text style={styles.vide}>Aucun élément pour l’instant.</Text>}
        renderItem={({ item }) => {
          const enLecture = clientIdEnLecture === item.clientId;
          const progression =
            enLecture && statutLecture.duration > 0 ? statutLecture.currentTime / statutLecture.duration : 0;

          return (
            <View style={styles.ligne}>
              <Text style={styles.duree}>{libelleEntete(item)}</Text>
              <Text style={styles.statut}>{LIBELLE_STATUT[item.statut]}</Text>
              {item.statut === "en_erreur" && item.derniereErreurEnvoi && (
                <Text style={styles.erreurEnvoi}>Dernier échec d’envoi : {item.derniereErreurEnvoi}</Text>
              )}
              {item.noteTexte && <Text style={styles.note}>{item.noteTexte}</Text>}

              {enLecture && (
                <View style={styles.blocLecture}>
                  <View style={styles.barreProgression}>
                    <View style={[styles.barreProgressionRemplie, { width: `${Math.min(100, progression * 100)}%` }]} />
                  </View>
                  <Text style={styles.tempsLecture}>
                    {formaterSecondes(statutLecture.currentTime)} / {formaterSecondes(statutLecture.duration)}
                  </Text>
                </View>
              )}

              <View style={styles.actions}>
                {item.type === "audio" && (item.nombreSegments ?? 0) > 0 && (
                  <Pressable style={styles.boutonAction} onPress={() => basculerLecture(item)}>
                    <Text style={styles.boutonActionTexte}>
                      {enLecture && statutLecture.playing ? "⏸ Pause" : "▶ Réécouter"}
                    </Text>
                  </Pressable>
                )}
                {peutSupprimer(item) && (
                  <Pressable style={[styles.boutonAction, styles.boutonSuppression]} onPress={() => supprimer(item)}>
                    <Text style={styles.boutonActionTexte}>Supprimer</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  compteur: { color: "#9aa5b1", fontSize: 13, marginBottom: 12 },
  vide: { color: "#5b6878", textAlign: "center", marginTop: 40 },
  ligne: { backgroundColor: "#141c2b", borderRadius: 10, padding: 14, marginBottom: 10 },
  duree: { color: "#fff", fontSize: 16, fontWeight: "600" },
  statut: { color: "#9aa5b1", fontSize: 13, marginTop: 4 },
  note: { color: "#9aa5b1", fontSize: 13, marginTop: 4, fontStyle: "italic" },
  erreurEnvoi: { color: "#f87171", fontSize: 12, marginTop: 4 },
  blocLecture: { marginTop: 10 },
  barreProgression: { height: 6, backgroundColor: "#0b1220", borderRadius: 3, overflow: "hidden" },
  barreProgressionRemplie: { height: "100%", backgroundColor: "#3b82f6" },
  tempsLecture: { color: "#9aa5b1", fontSize: 11, marginTop: 4 },
  actions: { flexDirection: "row", gap: 10, marginTop: 10 },
  boutonAction: { backgroundColor: "#3b82f6", paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  boutonSuppression: { backgroundColor: "#7f1d1d" },
  boutonActionTexte: { color: "#fff", fontSize: 13, fontWeight: "600" },
});
