package expo.modules.audiospike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import java.io.File
import java.io.FileWriter

/**
 * Service de premier plan pour le spike de faisabilité (Prompt 4, étape 0).
 * Teste si Android maintient un MediaRecorder vivant écran verrouillé /
 * application en arrière-plan, sur la durée. Code jetable : pas de reprise
 * après coupure brutale, pas de chiffrement - uniquement pour le test.
 */
class RecordingService : Service() {

  companion object {
    const val ACTION_START = "expo.modules.audiospike.action.START"
    const val ACTION_STOP = "expo.modules.audiospike.action.STOP"
    const val EXTRA_OUTPUT_PATH = "outputPath"
    const val EXTRA_HEARTBEAT_PATH = "heartbeatPath"
    private const val CHANNEL_ID = "audio_spike_recording"
    private const val NOTIFICATION_ID = 4821

    @Volatile var enregistrementEnCours: Boolean = false
    @Volatile var demarreA: Long = 0L
    @Volatile var derniereErreur: String? = null
  }

  private var mediaRecorder: MediaRecorder? = null
  private var heartbeatHandler: Handler? = null
  private var heartbeatRunnable: Runnable? = null
  private var heartbeatPath: String? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        val outputPath = intent.getStringExtra(EXTRA_OUTPUT_PATH)
        val heartbeat = intent.getStringExtra(EXTRA_HEARTBEAT_PATH)
        if (outputPath != null && heartbeat != null) {
          demarrerEnregistrement(outputPath, heartbeat)
        }
      }
      ACTION_STOP -> {
        arreterEnregistrement()
        stopSelf()
      }
    }
    return START_STICKY
  }

  private fun creerNotification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val canalExistant = manager.getNotificationChannel(CHANNEL_ID)
      if (canalExistant == null) {
        val canal = NotificationChannel(
          CHANNEL_ID,
          "Enregistrement Aurore Mobile",
          NotificationManager.IMPORTANCE_LOW
        )
        canal.description = "Notification affichée pendant un enregistrement audio."
        manager.createNotificationChannel(canal)
      }
    }

    val builder = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Aurore Mobile")
      .setContentText("Enregistrement en cours (test de faisabilité)")
      .setOngoing(true)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)

    return builder.build()
  }

  private fun demarrerEnregistrement(outputPath: String, heartbeat: String) {
    if (enregistrementEnCours) return

    val notification = creerNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    try {
      File(outputPath).parentFile?.mkdirs()
      val recorder = MediaRecorder()
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioEncodingBitRate(32000)
      recorder.setAudioSamplingRate(44100)
      recorder.setOutputFile(outputPath)
      recorder.prepare()
      recorder.start()
      mediaRecorder = recorder

      heartbeatPath = heartbeat
      File(heartbeat).parentFile?.mkdirs()
      demarreA = System.currentTimeMillis()
      enregistrementEnCours = true
      derniereErreur = null

      demarrerHeartbeat()
    } catch (e: Exception) {
      derniereErreur = e.message ?: e.javaClass.simpleName
      enregistrementEnCours = false
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
    }
  }

  private fun demarrerHeartbeat() {
    val handler = Handler(Looper.getMainLooper())
    val runnable = object : Runnable {
      override fun run() {
        val chemin = heartbeatPath
        if (chemin != null) {
          try {
            FileWriter(chemin, true).use { it.write("${System.currentTimeMillis()}\n") }
          } catch (_: Exception) {
            // Ne doit jamais interrompre l'enregistrement pour un souci de log.
          }
        }
        handler.postDelayed(this, 1000)
      }
    }
    heartbeatHandler = handler
    heartbeatRunnable = runnable
    handler.post(runnable)
  }

  private fun arreterEnregistrement() {
    heartbeatRunnable?.let { heartbeatHandler?.removeCallbacks(it) }
    heartbeatHandler = null
    heartbeatRunnable = null

    try {
      mediaRecorder?.stop()
    } catch (_: Exception) {
      // L'arrêt peut échouer si le fichier est trop court - pas bloquant pour le spike.
    }
    try {
      mediaRecorder?.release()
    } catch (_: Exception) {
    }
    mediaRecorder = null
    enregistrementEnCours = false
    stopForeground(STOP_FOREGROUND_REMOVE)
  }

  override fun onDestroy() {
    arreterEnregistrement()
    super.onDestroy()
  }
}
