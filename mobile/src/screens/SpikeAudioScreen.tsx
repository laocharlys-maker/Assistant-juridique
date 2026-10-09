import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, PermissionsAndroid, Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import AudioSpike from "../../modules/audio-spike/src/AudioSpikeModule";

type Resultat = {
  dureeSecondes: number;
  tailleOctets: number;
  battementsAttendus: number;
  battementsRecus: number;
  ecartMaxMs: number;
  derniereErreur: string | null;
};

/**
 * Écran de test du spike audio (Prompt 4, étape 0) - jamais présenté comme
 * fonctionnel : sert uniquement à mesurer si Android maintient
 * l'enregistrement vivant écran verrouillé / application en arrière-plan.
 * À retirer avant la livraison finale de l'objectif A.
 */
export default function SpikeAudioScreen() {
  const [enCours, setEnCours] = useState(false);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const cheminsRef = useRef<{ audio: string; heartbeat: string; debut: number } | null>(null);

  useEffect(() => {
    const dossier = new Directory(Paths.cache, "spike-audio");
    if (!dossier.exists) dossier.create();
  }, []);

  function versCheminNatif(uri: string): string {
    return uri.replace(/^file:\/\//, "");
  }

  async function demanderPermissions(): Promise<boolean> {
    const demandes = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
    if (Number(Platform.Version) >= 33) {
      demandes.push("android.permission.POST_NOTIFICATIONS" as never);
    }
    const resultats = await PermissionsAndroid.requestMultiple(demandes);
    return Object.values(resultats).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }

  async function demarrer() {
    setErreur(null);
    setResultat(null);
    const ok = await demanderPermissions();
    if (!ok) {
      setErreur("Permission micro ou notification refusée.");
      return;
    }

    const horodatage = Date.now();
    const dossier = new Directory(Paths.cache, "spike-audio");
    const audio = new File(dossier, `enregistrement-${horodatage}.m4a`);
    const heartbeat = new File(dossier, `heartbeat-${horodatage}.log`);

    const cheminAudio = versCheminNatif(audio.uri);
    const cheminHeartbeat = versCheminNatif(heartbeat.uri);
    cheminsRef.current = { audio: cheminAudio, heartbeat: cheminHeartbeat, debut: horodatage };

    AudioSpike.demarrer(cheminAudio, cheminHeartbeat);
    setEnCours(true);
  }

  async function arreter() {
    AudioSpike.arreter();
    setEnCours(false);

    const refs = cheminsRef.current;
    if (!refs) return;

    // Laisse le temps au service de finaliser le fichier (stop + release MediaRecorder).
    await new Promise((resolve) => setTimeout(resolve, 800));

    const etat = AudioSpike.etat();
    const dureeSecondes = Math.round((Date.now() - refs.debut) / 1000);

    let tailleOctets = 0;
    let battementsRecus = 0;
    let ecartMaxMs = 0;
    try {
      const fichierAudio = new File(`file://${refs.audio}`);
      tailleOctets = fichierAudio.exists ? fichierAudio.size ?? 0 : 0;

      const fichierHeartbeat = new File(`file://${refs.heartbeat}`);
      if (fichierHeartbeat.exists) {
        const contenu = await fichierHeartbeat.text();
        const horodatages = contenu
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0)
          .map((l) => parseInt(l, 10));
        battementsRecus = horodatages.length;
        for (let i = 1; i < horodatages.length; i++) {
          const ecart = horodatages[i] - horodatages[i - 1];
          if (ecart > ecartMaxMs) ecartMaxMs = ecart;
        }
      }
    } catch (e) {
      setErreur(e instanceof Error ? e.message : "Erreur de lecture des fichiers de test.");
    }

    setResultat({
      dureeSecondes,
      tailleOctets,
      battementsAttendus: dureeSecondes,
      battementsRecus,
      ecartMaxMs,
      derniereErreur: etat.derniereErreur,
    });
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.titre}>Spike audio (test interne)</Text>
      <Text style={styles.aide}>
        Lance le test, verrouille l’écran, mets le téléphone en arrière-plan pendant la durée
        voulue (15 à 30 min), puis reviens ici et arrête le test.
      </Text>

      <Pressable
        style={[styles.bouton, enCours && styles.boutonDanger]}
        onPress={enCours ? arreter : demarrer}
      >
        <Text style={styles.boutonTexte}>{enCours ? "Arrêter le test" : "Démarrer le test"}</Text>
      </Pressable>

      {erreur && <Text style={styles.erreur}>{erreur}</Text>}

      {resultat && (
        <View style={styles.resultats}>
          <Text style={styles.ligneResultat}>Durée : {resultat.dureeSecondes} s</Text>
          <Text style={styles.ligneResultat}>
            Taille du fichier audio : {Math.round(resultat.tailleOctets / 1024)} Ko
          </Text>
          <Text style={styles.ligneResultat}>
            Battements reçus : {resultat.battementsRecus} / ~{resultat.battementsAttendus} attendus
          </Text>
          <Text style={styles.ligneResultat}>
            Écart maximum entre deux battements : {resultat.ecartMaxMs} ms
            {resultat.ecartMaxMs > 2000 ? "  ⚠️ coupure probable" : "  ✓ pas de coupure détectée"}
          </Text>
          {resultat.derniereErreur && (
            <Text style={styles.erreur}>Erreur native : {resultat.derniereErreur}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 20 },
  titre: { color: "#fff", fontSize: 18, fontWeight: "700", marginTop: 20, marginBottom: 8 },
  aide: { color: "#9aa5b1", fontSize: 13, marginBottom: 24 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 16, borderRadius: 10, alignItems: "center" },
  boutonDanger: { backgroundColor: "#7f1d1d" },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "600" },
  erreur: { color: "#f87171", marginTop: 16 },
  resultats: { marginTop: 24, gap: 8 },
  ligneResultat: { color: "#fff", fontSize: 14 },
});
