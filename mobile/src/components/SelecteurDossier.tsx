import React, { useEffect, useMemo, useState } from "react";
import { View, Text, TextInput, FlatList, Pressable, StyleSheet } from "react-native";
import { listerDossiersCache, type DossierCache } from "../storage/db";

/**
 * Sélecteur de dossier partagé (Prompt 4, objectif C) - les audiences du
 * jour d'abord, puis recherche. Réutilisé avant ET après l'enregistrement
 * (le dossier peut être choisi à l'un ou l'autre moment, ou jamais -
 * "à classer").
 */
export default function SelecteurDossier({
  dossierSelectionneId,
  onSelection,
}: {
  dossierSelectionneId: string | null;
  onSelection: (dossierId: string | null) => void;
}) {
  const [dossiers, setDossiers] = useState<DossierCache[]>([]);
  const [recherche, setRecherche] = useState("");

  useEffect(() => {
    listerDossiersCache().then(setDossiers);
  }, []);

  const dossiersTries = useMemo(() => {
    const aujourdhui = new Date().toDateString();
    const filtres = recherche.trim()
      ? dossiers.filter((d) =>
          `${d.numeroDossier} ${d.nomAffaire} ${d.nomClient}`.toLowerCase().includes(recherche.trim().toLowerCase())
        )
      : dossiers;
    return [...filtres].sort((a, b) => {
      const aAujourdhui = a.prochaineAudience ? new Date(a.prochaineAudience).toDateString() === aujourdhui : false;
      const bAujourdhui = b.prochaineAudience ? new Date(b.prochaineAudience).toDateString() === aujourdhui : false;
      if (aAujourdhui !== bAujourdhui) return aAujourdhui ? -1 : 1;
      return 0;
    });
  }, [dossiers, recherche]);

  return (
    <View style={styles.conteneur}>
      <TextInput
        style={styles.recherche}
        value={recherche}
        onChangeText={setRecherche}
        placeholder="Rechercher un dossier…"
        placeholderTextColor="#5b6878"
      />
      <Pressable
        style={[styles.ligne, dossierSelectionneId === null && styles.ligneActive]}
        onPress={() => onSelection(null)}
      >
        <Text style={styles.aClasser}>À classer (choisir plus tard)</Text>
      </Pressable>
      <FlatList
        data={dossiersTries}
        keyExtractor={(item) => item.id}
        style={styles.liste}
        renderItem={({ item }) => {
          const estAujourdhui =
            item.prochaineAudience && new Date(item.prochaineAudience).toDateString() === new Date().toDateString();
          return (
            <Pressable
              style={[styles.ligne, dossierSelectionneId === item.id && styles.ligneActive]}
              onPress={() => onSelection(item.id)}
            >
              <Text style={styles.affaire}>{item.nomAffaire}</Text>
              <Text style={styles.client}>{item.nomClient}</Text>
              {estAujourdhui && <Text style={styles.badgeAujourdhui}>Audience aujourd’hui</Text>}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1 },
  recherche: {
    borderWidth: 1,
    borderColor: "#2a3545",
    borderRadius: 10,
    padding: 10,
    color: "#fff",
    marginBottom: 10,
  },
  liste: { flex: 1 },
  ligne: { backgroundColor: "#141c2b", borderRadius: 10, padding: 12, marginBottom: 8 },
  ligneActive: { borderWidth: 2, borderColor: "#3b82f6" },
  aClasser: { color: "#9aa5b1", fontSize: 14 },
  affaire: { color: "#fff", fontSize: 15, fontWeight: "600" },
  client: { color: "#9aa5b1", fontSize: 13 },
  badgeAujourdhui: { color: "#f59e0b", fontSize: 12, marginTop: 4 },
});
