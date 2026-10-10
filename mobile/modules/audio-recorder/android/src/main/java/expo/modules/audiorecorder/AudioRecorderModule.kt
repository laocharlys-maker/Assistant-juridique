package expo.modules.audiorecorder

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AudioRecorderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AudioRecorder")

    Function("demarrer") { dossierSegments: String, dureeSegmentMs: Int ->
      val contexte = appContext.reactContext ?: return@Function Unit
      val intent = Intent(contexte, EnregistrementService::class.java).apply {
        action = EnregistrementService.ACTION_DEMARRER
        putExtra(EnregistrementService.EXTRA_DOSSIER, dossierSegments)
        putExtra(EnregistrementService.EXTRA_DUREE_SEGMENT_MS, dureeSegmentMs.toLong())
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        contexte.startForegroundService(intent)
      } else {
        contexte.startService(intent)
      }
      Unit
    }

    Function("mettreEnPause") {
      envoyerAction(EnregistrementService.ACTION_PAUSE)
      Unit
    }

    Function("reprendre") {
      envoyerAction(EnregistrementService.ACTION_REPRENDRE)
      Unit
    }

    Function("arreter") {
      envoyerAction(EnregistrementService.ACTION_ARRETER)
      Unit
    }

    Function("niveauSonore") {
      return@Function EnregistrementService.instance?.niveauSonore() ?: 0
    }

    Function("recupererSegmentsTermines") {
      return@Function EnregistrementService.drainerSegmentsTermines()
    }

    Function("etat") {
      return@Function mapOf(
        "enCours" to EnregistrementService.enCours,
        "enPause" to EnregistrementService.enPause,
        "derniereErreur" to EnregistrementService.derniereErreur
      )
    }
  }

  private fun envoyerAction(action: String) {
    val contexte = appContext.reactContext ?: return
    val intent = Intent(contexte, EnregistrementService::class.java).apply { this.action = action }
    contexte.startService(intent)
  }
}
