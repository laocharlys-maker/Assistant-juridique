package expo.modules.deviceintegrity

import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Detection de debridage (root) - Prompt 7, objectif A. Plusieurs indices
 * independants combines (jamais un seul), chacun contournable
 * individuellement par un utilisateur suffisamment determine (Magisk
 * Hide/Zygisk notamment) - voir docs/lot10/07-securite.md pour
 * l'evaluation honnete de la fiabilite reelle de cette detection. Aucune
 * bibliotheque tierce (meme logique que modules/image-warp,
 * modules/audio-recorder : du code maison, verifiable, plutot que de
 * faire confiance a une dependance non auditee pour une fonction de
 * securite).
 */
private val CHEMINS_SU = listOf(
  "/system/bin/su",
  "/system/xbin/su",
  "/sbin/su",
  "/system/app/Superuser.apk",
  "/system/sd/xbin/su",
  "/system/bin/failsafe/su",
  "/data/local/su",
  "/data/local/bin/su",
  "/data/local/xbin/su"
)

// Paquets d'applications de gestion root connues - une detection par nom
// de paquet precis reste fiable meme sur Android 11+ (restriction de
// visibilite des paquets), contrairement a une liste complete de toutes
// les apps installees.
private val PAQUETS_ROOT_CONNUS = listOf(
  "com.topjohnwu.magisk",
  "com.noshufou.android.su",
  "com.noshufou.android.su.elite",
  "eu.chainfire.supersu",
  "com.koushikdutta.superuser",
  "com.thirdparty.superuser",
  "com.yellowes.su",
  "com.kingroot.kinguser",
  "com.kingo.root",
  "com.smedialink.oneclickroot",
  "com.zhiqupk.root.global",
  "com.alephzain.framaroot"
)

class DeviceIntegrityModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("DeviceIntegrity")

    Function("estAppareilProbablementDebride") {
      detecterIndicesDebridage()
    }
  }

  private fun detecterIndicesDebridage(): Boolean {
    return buildTagsSuspectes() || binaireSuDetecte() || paqueRootDetecte()
  }

  // "test-keys" indique un build signe avec les cles de test AOSP, jamais
  // le cas d'une ROM officielle signee par le fabricant - fort indice
  // (mais pas preuve absolue, certaines ROMs tierces legitimes l'ont aussi).
  private fun buildTagsSuspectes(): Boolean {
    val tags = Build.TAGS ?: return false
    return tags.contains("test-keys")
  }

  private fun binaireSuDetecte(): Boolean {
    return CHEMINS_SU.any { chemin ->
      try {
        File(chemin).exists()
      } catch (_: Exception) {
        // Accès refusé (SELinux) - ni une preuve de presence ni d'absence,
        // traite comme "non detecte" par ce chemin precis.
        false
      }
    }
  }

  private fun paqueRootDetecte(): Boolean {
    val pm = appContext.reactContext?.packageManager ?: return false
    return PAQUETS_ROOT_CONNUS.any { paquet ->
      try {
        pm.getPackageInfo(paquet, 0)
        true
      } catch (_: PackageManager.NameNotFoundException) {
        false
      } catch (_: Exception) {
        false
      }
    }
  }
}
