package expo.modules.audiospike

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AudioSpikeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AudioSpike")

    Function("demarrer") { cheminAudio: String, cheminHeartbeat: String ->
      val contexte = appContext.reactContext ?: return@Function Unit
      val intent = Intent(contexte, RecordingService::class.java).apply {
        action = RecordingService.ACTION_START
        putExtra(RecordingService.EXTRA_OUTPUT_PATH, cheminAudio)
        putExtra(RecordingService.EXTRA_HEARTBEAT_PATH, cheminHeartbeat)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        contexte.startForegroundService(intent)
      } else {
        contexte.startService(intent)
      }
      Unit
    }

    Function("arreter") {
      val contexte = appContext.reactContext ?: return@Function Unit
      val intent = Intent(contexte, RecordingService::class.java).apply {
        action = RecordingService.ACTION_STOP
      }
      contexte.startService(intent)
      Unit
    }

    Function("etat") {
      return@Function mapOf(
        "enCours" to RecordingService.enregistrementEnCours,
        "demarreA" to RecordingService.demarreA,
        "derniereErreur" to RecordingService.derniereErreur
      )
    }
  }
}
