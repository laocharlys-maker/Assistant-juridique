import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { definirAdressePc, oublierAppairage } from "../pairing/appareil";
import { lireDelaiVerrouillageMinutes, definirDelaiVerrouillageMinutes } from "../lock/lock";
import { lireValeur } from "../vault/vault";
import type { RootStackParamList } from "../navigation/RootNavigator";

type Props = NativeStackScreenProps<RootStackParamList, "Reglages">;

const DELAIS_PROPOSES = [1, 2, 5, 10];

/**
 * Réglages (Prompt 3) - l'adresse du PC est modifiable à la main : l'IP
 * peut changer sur le réseau du cabinet (contrainte explicite du plan),
 * sans devoir réappairer entièrement.
 */
export default function ReglagesScreen({ navigation }: Props) {
  const [adresse, setAdresse] = useState("");
  const [delaiMinutes, setDelaiMinutes] = useState(2);

  useEffect(() => {
    (async () => {
      setAdresse((await lireValeur("aurore_mobile_adresse_pc_v1")) || "");
      setDelaiMinutes(await lireDelaiVerrouillageMinutes());
    })();
  }, []);

  async function enregistrerAdresse() {
    if (!adresse.trim()) return;
    await definirAdressePc(adresse.trim());
    Alert.alert("Enregistré", "Adresse de l'ordinateur mise à jour.");
  }

  async function changerDelai(minutes: number) {
    setDelaiMinutes(minutes);
    await definirDelaiVerrouillageMinutes(minutes);
  }

  function confirmerOubliAppairage() {
    Alert.alert(
      "Déconnecter cet appareil ?",
      "Il faudra scanner un nouveau QR sur l'ordinateur pour reconnecter ce téléphone.",
      [
        { text: "Annuler", style: "cancel" },
        {
          text: "Déconnecter",
          style: "destructive",
          onPress: async () => {
            await oublierAppairage();
            navigation.reset({ index: 0, routes: [{ name: "Appairage" }] });
          },
        },
      ]
    );
  }

  return (
    <View style={styles.conteneur}>
      <Text style={styles.section}>Adresse de l’ordinateur</Text>
      <Text style={styles.aide}>Si l’adresse du PC a changé sur le réseau du cabinet, corrige-la ici (format : 192.168.1.42:3100).</Text>
      <TextInput style={styles.champ} value={adresse} onChangeText={setAdresse} placeholder="192.168.1.42:3100" placeholderTextColor="#5b6878" />
      <Pressable style={styles.bouton} onPress={enregistrerAdresse}>
        <Text style={styles.boutonTexte}>Enregistrer l’adresse</Text>
      </Pressable>

      <Text style={[styles.section, { marginTop: 32 }]}>Verrouillage automatique</Text>
      <View style={styles.rangeeDelais}>
        {DELAIS_PROPOSES.map((minutes) => (
          <Pressable
            key={minutes}
            style={[styles.puceDelai, delaiMinutes === minutes && styles.puceDelaiActive]}
            onPress={() => changerDelai(minutes)}
          >
            <Text style={styles.puceDelaiTexte}>{minutes} min</Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.bouton, styles.boutonDanger, { marginTop: 40 }]} onPress={confirmerOubliAppairage}>
        <Text style={styles.boutonTexte}>Déconnecter cet appareil</Text>
      </Pressable>

      <Pressable style={[styles.bouton, { marginTop: 40, backgroundColor: "#374151" }]} onPress={() => navigation.navigate("SpikeAudio")}>
        <Text style={styles.boutonTexte}>Spike audio (test interne)</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  conteneur: { flex: 1, backgroundColor: "#0b1220", padding: 20 },
  section: { color: "#fff", fontSize: 16, fontWeight: "600", marginBottom: 6 },
  aide: { color: "#9aa5b1", fontSize: 13, marginBottom: 12 },
  champ: { borderWidth: 1, borderColor: "#2a3545", borderRadius: 10, padding: 12, color: "#fff", marginBottom: 12 },
  bouton: { backgroundColor: "#3b82f6", paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  boutonDanger: { backgroundColor: "#7f1d1d" },
  boutonTexte: { color: "#fff", fontSize: 15, fontWeight: "600" },
  rangeeDelais: { flexDirection: "row", gap: 10 },
  puceDelai: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 20, backgroundColor: "#1a2332" },
  puceDelaiActive: { backgroundColor: "#3b82f6" },
  puceDelaiTexte: { color: "#fff", fontSize: 13 },
});
