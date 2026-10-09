import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, RefreshControl, StyleSheet } from "react-native";
import { envoyerRequeteAuthentifiee } from "../pairing/appareil";
import { remplacerCacheDossiers, listerDossiersCache, dateDerniereMajDossiers, DossierCache } from "../storage/db";

/**
 * Liste des dossiers (Prompt 3, objectif F) - consultable hors ligne
 * (cache chiffré local), rafraîchie depuis le serveur quand le réseau est
 * disponible. Jamais d'erreur bloquante si le PC est injoignable : la
 * dernière liste connue reste affichée, avec sa date.
 */
export default function DossiersScreen() {
  const [dossiers, setDossiers] = useState<DossierCache[]>([]);
  const [derniereMaj, setDerniereMaj] = useState<Date | null>(null);
  const [enChargement, setEnChargement] = useState(false);
  const [erreurReseau, setErreurReseau] = useState<string | null>(null);

  const chargerDepuisCache = useCallback(async () => {
    setDossiers(await listerDossiersCache());
    setDerniereMaj(await dateDerniereMajDossiers());
  }, []);

  const synchroniser = useCallback(async () => {
    setEnChargement(true);
    setErreurReseau(null);
    try {
      const recus = await envoyerRequeteAuthentifiee<DossierCache[]>("/api/m/dossiers", {});
      await remplacerCacheDossiers(recus);
      await chargerDepuisCache();
    } catch {
      setErreurReseau("Aurore introuvable - affichage de la dernière liste connue.");
    } finally {
      setEnChargement(false);
    }
  }, [chargerDepuisCache]);

  useEffect(() => {
    // Chargement initial (cache puis synchronisation reseau) au montage de
    // l'ecran - aucun setState synchrone ici, les deux fonctions appellees
    // sont asynchrones (le setState reel n'arrive qu'apres leur await
    // interne, dans un microtask distinct du corps de cet effet). La regle
    // experimentale react-hooks/set-state-in-effect ne distingue pas ce cas
    // du veritable anti-pattern qu'elle vise (setState synchrone immediat).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    chargerDepuisCache().then(synchroniser);
  }, [chargerDepuisCache, synchroniser]);

  return (
    <View style={styles.conteneur}>
      {derniereMaj && (
        <Text style={styles.derniereMaj}>
          Dernière mise à jour : {derniereMaj.toLocaleDateString("fr-FR")} à {derniereMaj.toLocaleTimeString("fr-FR")}
        </Text>
      )}
      {erreurReseau && <Text style={styles.erreur}>{erreurReseau}</Text>}
      <FlatList
        data={dossiers}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={enChargement} onRefresh={synchroniser} tintColor="#fff" />}
        ListEmptyComponent={<Text style={styles.vide}>Aucun dossier pour l’instant.</Text>}
        renderItem={({ item }) => (
          <View style={styles.ligne}>
            <Text style={styles.numero}>{item.numeroDossier}</Text>
            <Text style={styles.affaire}>{item.nomAffaire}</Text>
            <Text style={styles.client}>{item.nomClient}</Text>
            {item.prochaineAudience && (
              <Text style={styles.audience}>Prochaine audience : {new Date(item.prochaineAudience).toLocaleDateString("fr-FR")}</Text>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  derniereMaj: { color: "#5b6878", fontSize: 12, marginBottom: 8 },
  erreur: { color: "#f59e0b", fontSize: 13, marginBottom: 8 },
  vide: { color: "#5b6878", textAlign: "center", marginTop: 40 },
  ligne: { backgroundColor: "#141c2b", borderRadius: 10, padding: 14, marginBottom: 10 },
  numero: { color: "#3b82f6", fontSize: 13, fontWeight: "600" },
  affaire: { color: "#fff", fontSize: 16, fontWeight: "600", marginTop: 2 },
  client: { color: "#9aa5b1", fontSize: 13, marginTop: 2 },
  audience: { color: "#f59e0b", fontSize: 12, marginTop: 6 },
});
