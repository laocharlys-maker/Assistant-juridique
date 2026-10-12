import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, Image, StyleSheet } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { verifierEtatConnexion, type EtatConnexion } from "../pairing/appareil";
import { listerElementsLocaux } from "../storage/db";
import { compterElementsEnAttente } from "../sync/elements";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "Accueil">;

const DETAIL_ETAT: Record<Exclude<EtatConnexion, "connecte">, string> = {
  introuvable: "Aurore introuvable sur ce réseau",
  // Prompt 6, objectif E - message distinct et explicite, jamais confondu
  // avec une simple coupure réseau (qui se résout d'elle-même).
  revoque: "Appareil révoqué - demande un nouvel appairage au titulaire",
};

/**
 * Écran d'accueil (Prompts 3 et 4, refonte visuelle ultérieure). En-tête
 * bleu nuit avec logo + pastille de connexion en haut à droite, corps sur
 * fond blanc.
 */
export default function AccueilScreen({ navigation }: Props) {
  const insets = useSafeAreaInsets();
  const [etat, setEtat] = useState<EtatConnexion | null>(null);
  const [nomUtilisateur, setNomUtilisateur] = useState<string | null>(null);
  const [enAttenteEnvoi, setEnAttenteEnvoi] = useState(0);

  const verifierConnexion = useCallback(async () => {
    const infos = await verifierEtatConnexion();
    setEtat(infos.etat);
    if (infos.nomUtilisateur) setNomUtilisateur(infos.nomUtilisateur);
  }, []);

  const compterEnAttente = useCallback(async () => {
    setEnAttenteEnvoi(compterElementsEnAttente(await listerElementsLocaux()));
  }, []);

  useFocusEffect(
    useCallback(() => {
      verifierConnexion();
      compterEnAttente();
    }, [verifierConnexion, compterEnAttente])
  );

  useEffect(() => {
    const intervalle = setInterval(verifierConnexion, 15000);
    return () => clearInterval(intervalle);
  }, [verifierConnexion]);

  const connecte = etat === "connecte";

  return (
    <View style={styles.conteneur}>
      <View style={[styles.enTete, { paddingTop: insets.top + 14 }]}>
        <View style={styles.enTeteIdentite}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} resizeMode="contain" />
          <Text style={styles.titreApp}>Aurore Mobile</Text>
        </View>
        <View style={[styles.pastilleEtat, { backgroundColor: connecte ? "#16a34a" : "#dc2626" }]}>
          <View style={[styles.pointEtat, { backgroundColor: connecte ? "#4ade80" : "#fca5a5" }]} />
          <Text style={styles.pastilleEtatTexte}>{connecte ? "Connecté" : "Non connecté"}</Text>
        </View>
      </View>

      <View style={styles.corps}>
        <Text style={styles.bienvenue}>Bienvenue{nomUtilisateur ? ` ${nomUtilisateur}` : ""}</Text>
        {etat && etat !== "connecte" && <Text style={styles.detailEtat}>{DETAIL_ETAT[etat]}</Text>}

        <Pressable style={styles.carteElements} onPress={() => navigation.navigate("MesElements")}>
          <Text style={styles.carteElementsTitre}>📁 Mes éléments</Text>
          <Text style={styles.carteElementsDetail}>
            {enAttenteEnvoi} élément{enAttenteEnvoi === 1 ? "" : "s"} en attente d’envoi
          </Text>
        </Pressable>

        <Pressable style={styles.boutonPrincipal} onPress={() => navigation.navigate("ApresAudience")}>
          <Text style={styles.boutonPrincipalTexte}>🎙️ Après audience</Text>
        </Pressable>

        <View style={styles.rangeeBoutons}>
          <Pressable style={styles.boutonSecondaireCarre} onPress={() => navigation.navigate("Scan")}>
            <Text style={styles.boutonSecondaireCarreTexte}>📄 Scanner</Text>
          </Pressable>
          <Pressable style={styles.boutonSecondaireCarre} onPress={() => navigation.navigate("NoteTexte")}>
            <Text style={styles.boutonSecondaireCarreTexte}>📝 Note</Text>
          </Pressable>
        </View>

        <View style={styles.rangeeBoutons}>
          <Pressable style={styles.boutonRaccourci} onPress={() => navigation.navigate("Dossiers")}>
            <Text style={styles.boutonRaccourciIcone}>🗂️</Text>
            <Text style={styles.boutonRaccourciTexte}>Mes dossiers</Text>
          </Pressable>
          <Pressable style={styles.boutonRaccourci} onPress={() => navigation.navigate("Reglages")}>
            <Text style={styles.boutonRaccourciIcone}>⚙️</Text>
            <Text style={styles.boutonRaccourciTexte}>Mes réglages</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#ffffff" },
  enTete: {
    backgroundColor: "#0b1220",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  enTeteIdentite: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 30, height: 30, borderRadius: 6 },
  titreApp: { color: "#fff", fontSize: 17, fontWeight: "700" },
  pastilleEtat: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  pointEtat: { width: 8, height: 8, borderRadius: 4 },
  pastilleEtatTexte: { color: "#fff", fontSize: 12, fontWeight: "600" },
  corps: { flex: 1, padding: 24 },
  bienvenue: { color: "#0f172a", fontSize: 22, fontWeight: "700", marginTop: 4 },
  detailEtat: { color: "#b91c1c", fontSize: 13, marginTop: 6, marginBottom: 12 },
  carteElements: {
    backgroundColor: "#f8fafc",
    borderRadius: 12,
    padding: 16,
    marginTop: 24,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  carteElementsTitre: { color: "#0f172a", fontSize: 16, fontWeight: "700" },
  carteElementsDetail: { color: "#64748b", fontSize: 13, marginTop: 4 },
  boutonPrincipal: {
    backgroundColor: "#0b1220",
    paddingVertical: 28,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 20,
  },
  boutonPrincipalTexte: { color: "#fff", fontSize: 20, fontWeight: "700" },
  rangeeBoutons: { flexDirection: "row", gap: 12, marginBottom: 14 },
  boutonSecondaireCarre: {
    flex: 1,
    backgroundColor: "#f1f5f9",
    paddingVertical: 18,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  boutonSecondaireCarreTexte: { color: "#0f172a", fontSize: 15, fontWeight: "600" },
  boutonRaccourci: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#3b82f6",
  },
  boutonRaccourciIcone: { fontSize: 20, marginBottom: 4 },
  boutonRaccourciTexte: { color: "#1e40af", fontSize: 14, fontWeight: "700" },
});
