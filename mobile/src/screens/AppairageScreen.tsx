import React, { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  parserQr,
  demanderAppairage,
  envoyerRequeteAuthentifiee,
  QrExpireError,
  PcIntrouvableError,
  SecretInvalideError,
} from "../pairing/appareil";

type Etape = "scan" | "connexion" | "attente" | "autorise" | "refuse" | "erreur";

const INTERVALLE_POLL_MS = 3000;

/**
 * Appairage par QR (Prompt 3, objectif D) - voir docs/lot10/01-protocole.md.
 * Le nom de l'appareil envoyé au PC n'est volontairement pas demandé à
 * l'utilisateur ici (pas de champ texte supplémentaire à cette étape déjà
 * stressante) : "Téléphone Android" + un suffixe court, modifiable plus
 * tard côté PC si besoin (hors périmètre de ce prompt).
 */
export default function AppairageScreen({ onAppaire }: { onAppaire: () => void }) {
  const [permission, demanderPermission] = useCameraPermissions();
  const [etape, setEtape] = useState<Etape>("scan");
  const [message, setMessage] = useState("");
  const dejaTraiteRef = useRef(false);
  const deviceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (etape !== "attente" || !deviceIdRef.current) return;
    const intervalle = setInterval(async () => {
      try {
        const reponse = await envoyerRequeteAuthentifiee<{ statut: string }>(
          `/api/m/appairage/statut/${deviceIdRef.current}`,
          {}
        );
        if (reponse.statut === "autorise") {
          clearInterval(intervalle);
          setEtape("autorise");
          setTimeout(onAppaire, 800);
        } else if (reponse.statut === "revoque") {
          clearInterval(intervalle);
          setEtape("refuse");
          setMessage("L'appairage a été refusé sur l'ordinateur.");
        }
      } catch {
        // Coupure réseau ponctuelle pendant l'attente - jamais bloquant,
        // le prochain sondage réessaiera.
      }
    }, INTERVALLE_POLL_MS);
    return () => clearInterval(intervalle);
  }, [etape, onAppaire]);

  async function surScan({ data }: { data: string }) {
    if (dejaTraiteRef.current) return;
    dejaTraiteRef.current = true;
    setEtape("connexion");
    setMessage("Connexion à l'ordinateur du cabinet…");

    try {
      const qr = parserQr(data);
      const resultat = await demanderAppairage(qr, "Téléphone Android");
      deviceIdRef.current = resultat.deviceId;
      if (resultat.statut === "autorise") {
        setEtape("autorise");
        setTimeout(onAppaire, 800);
      } else {
        setEtape("attente");
        setMessage("En attente de confirmation sur l'ordinateur…");
      }
    } catch (error) {
      dejaTraiteRef.current = false;
      if (error instanceof QrExpireError) {
        setMessage("Ce QR a expiré ou a déjà été utilisé. Génère un nouveau QR sur l'ordinateur.");
      } else if (error instanceof SecretInvalideError) {
        setMessage("Ce QR n'est pas valide.");
      } else if (error instanceof PcIntrouvableError) {
        setMessage("Aurore introuvable sur ce réseau. Vérifie que l'ordinateur et le téléphone sont sur le même Wi-Fi.");
      } else {
        setMessage("Échec de l'appairage. Réessaie.");
      }
      setEtape("erreur");
    }
  }

  function reessayer() {
    dejaTraiteRef.current = false;
    deviceIdRef.current = null;
    setMessage("");
    setEtape("scan");
  }

  if (!permission) {
    return <View style={styles.conteneur} />;
  }

  if (!permission.granted) {
    return (
      <View style={styles.conteneur}>
        <Text style={styles.texte}>Aurore Mobile a besoin de la caméra pour scanner le QR d’appairage.</Text>
        <Pressable style={styles.bouton} onPress={demanderPermission}>
          <Text style={styles.boutonTexte}>Autoriser la caméra</Text>
        </Pressable>
      </View>
    );
  }

  if (etape === "scan") {
    return (
      <View style={styles.conteneur}>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={surScan}
        />
        <Text style={styles.texteSousCamera}>Scanne le QR affiché sur l’écran « Appareils mobiles » d’Aurore.</Text>
      </View>
    );
  }

  return (
    <View style={styles.conteneur}>
      {(etape === "connexion" || etape === "attente") && <ActivityIndicator size="large" color="#3b82f6" />}
      <Text style={styles.texte}>{message || "…"}</Text>
      {etape === "autorise" && <Text style={styles.texteSucces}>Appareil autorisé ✓</Text>}
      {(etape === "erreur" || etape === "refuse") && (
        <Pressable style={styles.bouton} onPress={reessayer}>
          <Text style={styles.boutonTexte}>Scanner à nouveau</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, backgroundColor: "#0b1220" },
  camera: { width: "100%", aspectRatio: 1, borderRadius: 16, overflow: "hidden" },
  texte: { color: "#fff", fontSize: 16, textAlign: "center", marginTop: 16 },
  texteSousCamera: { color: "#9aa5b1", fontSize: 14, textAlign: "center", marginTop: 16 },
  texteSucces: { color: "#4ade80", fontSize: 18, fontWeight: "600", marginTop: 12 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 14, paddingHorizontal: 32, borderRadius: 10, marginTop: 20 },
  boutonTexte: { color: "#fff", fontSize: 16, fontWeight: "600" },
});
