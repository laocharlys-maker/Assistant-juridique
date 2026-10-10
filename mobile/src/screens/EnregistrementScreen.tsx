import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  mettreEnPause,
  reprendre,
  dureeEcouleeMs,
  niveauSonore,
  ajouterMarqueur,
  definirDateProchaineAudience,
  arreterEtEnregistrer,
} from "../audio/recorder";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "Enregistrement">;

function formaterDuree(ms: number): string {
  const totalSecondes = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSecondes / 60);
  const secondes = totalSecondes % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secondes).padStart(2, "0")}`;
}

const BOUTONS_REPERES: { type: "decision" | "a_faire" | "point_important" | "prochaine_audience"; label: string }[] = [
  { type: "prochaine_audience", label: "📅 Prochaine audience" },
  { type: "decision", label: "⚖️ Décision" },
  { type: "a_faire", label: "✅ À faire" },
  { type: "point_important", label: "⭐ Point important" },
];

/**
 * Écran d'enregistrement (Prompt 4, objectifs A et B) - le gros bouton
 * pause/reprise et les 4 repères n'interrompent jamais l'enregistrement
 * lui-même (le service natif continue en arrière-plan quoi qu'il arrive à
 * l'écran).
 */
export default function EnregistrementScreen({ navigation, route }: Props) {
  const [enPause, setEnPause] = useState(false);
  const [duree, setDuree] = useState(0);
  const [niveau, setNiveau] = useState(0);
  const [nombreReperes, setNombreReperes] = useState(0);
  const [afficherDate, setAfficherDate] = useState(false);
  const dossierIdRef = useRef(route.params.dossierId);

  useEffect(() => {
    const intervalle = setInterval(() => {
      setDuree(dureeEcouleeMs());
      setNiveau(niveauSonore());
    }, 300);
    return () => clearInterval(intervalle);
  }, []);

  function togglePause() {
    if (enPause) {
      reprendre();
      setEnPause(false);
    } else {
      mettreEnPause();
      setEnPause(true);
    }
  }

  function poserRepere(type: (typeof BOUTONS_REPERES)[number]["type"]) {
    ajouterMarqueur(type, null);
    setNombreReperes((n) => n + 1);
    if (type === "prochaine_audience") setAfficherDate(true);
  }

  async function terminer() {
    const element = await arreterEtEnregistrer({ dossierId: dossierIdRef.current, noteTexte: null });
    navigation.replace("ApresEnregistrement", { clientId: element.clientId, dossierId: element.dossierId });
  }

  const niveauPourcent = Math.min(100, Math.round((niveau / 32767) * 100));

  return (
    <View style={styles.conteneur}>
      <Text style={styles.chrono}>{formaterDuree(duree)}</Text>
      <View style={styles.barreNiveau}>
        <View style={[styles.barreNiveauRemplie, { width: `${niveauPourcent}%` }]} />
      </View>
      {nombreReperes > 0 && <Text style={styles.compteurReperes}>{nombreReperes} repère(s) posé(s)</Text>}

      <Pressable style={[styles.boutonPause, enPause && styles.boutonPauseActif]} onPress={togglePause}>
        <Text style={styles.boutonPauseTexte}>{enPause ? "▶ Reprendre" : "⏸ Pause"}</Text>
      </Pressable>

      <View style={styles.grilleReperes}>
        {BOUTONS_REPERES.map((bouton) => (
          <Pressable key={bouton.type} style={styles.boutonRepere} onPress={() => poserRepere(bouton.type)}>
            <Text style={styles.boutonRepereTexte}>{bouton.label}</Text>
          </Pressable>
        ))}
      </View>

      {afficherDate && (
        <DateTimePicker
          value={new Date()}
          mode="date"
          onChange={(_evenement, date) => {
            setAfficherDate(false);
            if (date) definirDateProchaineAudience(date.toISOString());
          }}
        />
      )}

      <Pressable style={styles.boutonTerminer} onPress={terminer}>
        <Text style={styles.boutonTerminerTexte}>Terminer</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 20, alignItems: "center" },
  chrono: { color: "#fff", fontSize: 48, fontWeight: "700", marginTop: 30 },
  barreNiveau: { width: "100%", height: 8, backgroundColor: "#1a2332", borderRadius: 4, marginTop: 16, overflow: "hidden" },
  barreNiveauRemplie: { height: "100%", backgroundColor: "#4ade80" },
  compteurReperes: { color: "#9aa5b1", fontSize: 13, marginTop: 10 },
  boutonPause: {
    backgroundColor: "#3b82f6",
    paddingVertical: 20,
    paddingHorizontal: 50,
    borderRadius: 50,
    marginTop: 30,
  },
  boutonPauseActif: { backgroundColor: "#f59e0b" },
  boutonPauseTexte: { color: "#fff", fontSize: 18, fontWeight: "700" },
  grilleReperes: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 36, justifyContent: "center" },
  boutonRepere: { backgroundColor: "#141c2b", paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, width: "47%", alignItems: "center" },
  boutonRepereTexte: { color: "#fff", fontSize: 14 },
  boutonTerminer: { backgroundColor: "#7f1d1d", paddingVertical: 16, paddingHorizontal: 40, borderRadius: 12, marginTop: "auto" },
  boutonTerminerTexte: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
