import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, Image, Dimensions, ScrollView, PanResponder } from "react-native";
import { CameraView, useCameraPermissions, type CameraView as CameraViewType } from "expo-camera";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  demarrerScan,
  ajouterPage,
  listerPages,
  supprimerPage,
  deplacerPage,
  reinitialiserSessionScan,
} from "../scan/scanner";
import { EspaceDisqueInsuffisantError } from "../storage/espace";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "Scan">;

interface Point {
  x: number;
  y: number;
}

const LARGEUR_ECRAN = Dimensions.get("window").width;
const LARGEUR_APERCU = LARGEUR_ECRAN - 32;
const TAILLE_POIGNEE = 28;

/** Poignée déplaçable à un coin de la photo capturée - PanResponder est
 * déjà fourni par React Native (aucune dépendance de glisser-déposer
 * supplémentaire, cohérent avec docs/lot10/05-scan.md). */
function Poignee({ point, onDeplace }: { point: Point; onDeplace: (p: Point) => void }) {
  // `gestureState.dx/dy` (PanResponder) est le deplacement total depuis le
  // DEBUT du geste, jamais un delta incremental - on doit donc retenir le
  // point de depart (etat, jamais un ref : lire ref.current depuis une
  // fonction creee par useMemo casse la regle react-hooks/refs) pour
  // calculer point de depart + deplacement a chaque mouvement.
  const [depart, setDepart] = useState(point);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => setDepart(point),
        onPanResponderMove: (_evenement, geste) => {
          onDeplace({
            x: Math.min(LARGEUR_APERCU, Math.max(0, depart.x + geste.dx)),
            y: depart.y + geste.dy,
          });
        },
      }),
    [depart, point, onDeplace]
  );

  return (
    <View
      {...panResponder.panHandlers}
      style={[
        styles.poignee,
        { left: point.x - TAILLE_POIGNEE / 2, top: point.y - TAILLE_POIGNEE / 2 },
      ]}
    />
  );
}

/**
 * Scan de documents (Prompt 5, objectif A) - capture via expo-camera,
 * ajustement manuel des 4 coins (pas de détection automatique par IA, voir
 * docs/lot10/05-scan.md pour le compromis assumé), redressement par le
 * module natif modules/image-warp, pages multiples réordonnables.
 */
export default function ScanScreen({ navigation }: Props) {
  const [permission, demanderPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraViewType>(null);
  const [photoEnAjustement, setPhotoEnAjustement] = useState<{ uri: string; largeur: number; hauteur: number } | null>(
    null
  );
  const [coins, setCoins] = useState<[Point, Point, Point, Point] | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [enCapture, setEnCapture] = useState(false);
  const [enTraitement, setEnTraitement] = useState(false);

  useEffect(() => {
    try {
      demarrerScan();
    } catch (erreur) {
      if (erreur instanceof EspaceDisqueInsuffisantError) {
        Alert.alert("Stockage presque plein", "Libère de l'espace sur le téléphone avant de scanner un document.", [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
        return;
      }
      // Une session precedente n'a pas ete terminee (ecran quitte de
      // force) - meme recuperation que l'enregistrement audio : on
      // repart propre plutot que de bloquer l'utilisateur.
      reinitialiserSessionScan();
      demarrerScan();
    }
    // La session de scan (module scan/scanner.ts) survit volontairement a
    // la navigation vers ScannerEtClasserScreen (meme principe que la
    // session audio, qui survit a ApresEnregistrementScreen) - jamais
    // nettoyee ici au demontage de cet ecran. Ne doit s'executer qu'au
    // montage (navigation est stable, mais l'ajouter en dependance
    // relancerait ce bloc a chaque re-render sinon).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function hauteurApercu(largeur: number, hauteur: number): number {
    return LARGEUR_APERCU * (hauteur / largeur);
  }

  async function capturer() {
    if (!cameraRef.current || enCapture) return;
    setEnCapture(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) return;
      const hauteurAffichee = hauteurApercu(photo.width, photo.height);
      const marge = 0.08;
      setPhotoEnAjustement({ uri: photo.uri, largeur: photo.width, hauteur: photo.height });
      setCoins([
        { x: LARGEUR_APERCU * marge, y: hauteurAffichee * marge },
        { x: LARGEUR_APERCU * (1 - marge), y: hauteurAffichee * marge },
        { x: LARGEUR_APERCU * (1 - marge), y: hauteurAffichee * (1 - marge) },
        { x: LARGEUR_APERCU * marge, y: hauteurAffichee * (1 - marge) },
      ]);
    } catch {
      Alert.alert("Erreur", "Impossible de prendre la photo.");
    } finally {
      setEnCapture(false);
    }
  }

  async function validerPage() {
    if (!photoEnAjustement || !coins) return;
    setEnTraitement(true);
    try {
      const echelle = photoEnAjustement.largeur / LARGEUR_APERCU;
      const coinsPixel = coins.map((c) => ({ x: c.x * echelle, y: c.y * echelle }));
      await ajouterPage(photoEnAjustement.uri, coinsPixel);
      setPages(listerPages());
      setPhotoEnAjustement(null);
      setCoins(null);
    } catch {
      Alert.alert("Erreur", "Impossible de redresser cette page. Réessaie.");
    } finally {
      setEnTraitement(false);
    }
  }

  function annulerAjustement() {
    setPhotoEnAjustement(null);
    setCoins(null);
  }

  function retirerPage(index: number) {
    supprimerPage(index);
    setPages(listerPages());
  }

  function monterPage(index: number) {
    if (index === 0) return;
    deplacerPage(index, index - 1);
    setPages(listerPages());
  }

  function descendrePage(index: number) {
    if (index === pages.length - 1) return;
    deplacerPage(index, index + 1);
    setPages(listerPages());
  }

  function terminer() {
    if (pages.length === 0) {
      Alert.alert("Aucune page", "Ajoute au moins une page avant de terminer.");
      return;
    }
    navigation.replace("ScannerEtClasser");
  }

  if (!permission) return <View style={styles.conteneur} />;
  if (!permission.granted) {
    return (
      <View style={styles.conteneur}>
        <Text style={styles.texte}>Aurore Mobile a besoin de la caméra pour scanner un document.</Text>
        <Pressable style={styles.bouton} onPress={demanderPermission}>
          <Text style={styles.boutonTexte}>Autoriser la caméra</Text>
        </Pressable>
      </View>
    );
  }

  if (photoEnAjustement && coins) {
    const hauteurAffichee = hauteurApercu(photoEnAjustement.largeur, photoEnAjustement.hauteur);
    return (
      <View style={styles.conteneur}>
        <Text style={styles.texte}>Ajuste les 4 coins du document</Text>
        <View style={{ width: LARGEUR_APERCU, height: hauteurAffichee, alignSelf: "center", marginTop: 12 }}>
          <Image
            source={{ uri: photoEnAjustement.uri }}
            style={{ width: LARGEUR_APERCU, height: hauteurAffichee, borderRadius: 8 }}
          />
          {coins.map((coin, index) => (
            <Poignee
              key={index}
              point={coin}
              onDeplace={(p) =>
                setCoins((precedent) => {
                  if (!precedent) return precedent;
                  const copie = [...precedent] as [Point, Point, Point, Point];
                  copie[index] = p;
                  return copie;
                })
              }
            />
          ))}
        </View>
        <View style={styles.rangeeBoutons}>
          <Pressable style={[styles.bouton, styles.boutonSecondaire]} onPress={annulerAjustement}>
            <Text style={styles.boutonTexte}>Reprendre la photo</Text>
          </Pressable>
          <Pressable style={styles.bouton} onPress={validerPage} disabled={enTraitement}>
            <Text style={styles.boutonTexte}>{enTraitement ? "Redressement…" : "Valider cette page"}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.conteneur}>
      <CameraView ref={cameraRef} style={styles.camera} />
      <Pressable style={styles.boutonCapture} onPress={capturer} disabled={enCapture}>
        <View style={styles.boutonCaptureInterieur} />
      </Pressable>

      {pages.length > 0 && (
        <>
          <Text style={styles.texte}>
            {pages.length} page{pages.length > 1 ? "s" : ""}
          </Text>
          <ScrollView horizontal style={styles.vignettes}>
            {pages.map((uri, index) => (
              <View key={uri} style={styles.vignette}>
                <Image source={{ uri }} style={styles.vignetteImage} />
                <View style={styles.vignetteActions}>
                  <Pressable onPress={() => monterPage(index)} disabled={index === 0}>
                    <Text style={styles.vignetteActionTexte}>▲</Text>
                  </Pressable>
                  <Pressable onPress={() => retirerPage(index)}>
                    <Text style={styles.vignetteActionTexte}>🗑️</Text>
                  </Pressable>
                  <Pressable onPress={() => descendrePage(index)} disabled={index === pages.length - 1}>
                    <Text style={styles.vignetteActionTexte}>▼</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>
          <Pressable style={styles.bouton} onPress={terminer}>
            <Text style={styles.boutonTexte}>Terminer ({pages.length} page{pages.length > 1 ? "s" : ""})</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 16 },
  camera: { width: "100%", aspectRatio: 3 / 4, borderRadius: 16, overflow: "hidden" },
  texte: { color: "#fff", fontSize: 15, textAlign: "center", marginTop: 12 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 12 },
  boutonSecondaire: { backgroundColor: "#1a2332", flex: 1, marginRight: 8 },
  boutonTexte: { color: "#fff", fontSize: 15, fontWeight: "700" },
  rangeeBoutons: { flexDirection: "row", marginTop: 20 },
  boutonCapture: {
    alignSelf: "center",
    marginTop: 16,
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  boutonCaptureInterieur: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#fff" },
  poignee: {
    position: "absolute",
    width: TAILLE_POIGNEE,
    height: TAILLE_POIGNEE,
    borderRadius: TAILLE_POIGNEE / 2,
    backgroundColor: "#3b82f6",
    borderWidth: 2,
    borderColor: "#fff",
  },
  vignettes: { marginTop: 10, maxHeight: 110 },
  vignette: { marginRight: 10, width: 70 },
  vignetteImage: { width: 70, height: 90, borderRadius: 6, backgroundColor: "#1a2332" },
  vignetteActions: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  vignetteActionTexte: { fontSize: 13 },
});
