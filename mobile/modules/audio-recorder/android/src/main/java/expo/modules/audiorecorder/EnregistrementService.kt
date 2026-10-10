package expo.modules.audiorecorder

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

/**
 * Service de premier plan pour l'enregistrement reel (Prompt 4, objectif A),
 * construit sur le resultat du spike (docs/lot10/04-spike-audio.md) :
 * service de premier plan + notification permanente.
 *
 * Decoupe l'enregistrement en segments AAC_ADTS (format brut par trames,
 * jamais MPEG_4) a intervalle regulier : un flux ADTS peut etre concatene
 * bout a bout sans remuxage et reste un fichier audio valide - c'est ce qui
 * permet de chiffrer chaque segment des qu'il est termine (ecriture
 * continue et chiffree, cote JS) sans attendre la fin de tout
 * l'enregistrement, et de ne perdre au pire que le segment en cours en cas
 * de coupure brutale.
 */
class EnregistrementService : Service() {

  companion object {
    const val ACTION_DEMARRER = "expo.modules.audiorecorder.action.DEMARRER"
    const val ACTION_PAUSE = "expo.modules.audiorecorder.action.PAUSE"
    const val ACTION_REPRENDRE = "expo.modules.audiorecorder.action.REPRENDRE"
    const val ACTION_ARRETER = "expo.modules.audiorecorder.action.ARRETER"
    const val EXTRA_DOSSIER = "dossierSegments"
    const val EXTRA_DUREE_SEGMENT_MS = "dureeSegmentMs"
    private const val CHANNEL_ID = "aurore_enregistrement"
    private const val NOTIFICATION_ID = 4822

    @Volatile var enCours: Boolean = false
    @Volatile var enPause: Boolean = false
    @Volatile var derniereErreur: String? = null
    @Volatile var instance: EnregistrementService? = null

    private val segmentsTermines = mutableListOf<Map<String, Any>>()
    private val verrouSegments = Object()
    private var prochainNumero = 0

    /** Vide et renvoie les segments termines depuis le dernier appel -
     * chaque segment n'est donc signale qu'une seule fois au JS. */
    fun drainerSegmentsTermines(): List<Map<String, Any>> {
      synchronized(verrouSegments) {
        val copie = segmentsTermines.toList()
        segmentsTermines.clear()
        return copie
      }
    }

    fun niveauSonoreActuel(recorder: MediaRecorder?): Int {
      return try {
        recorder?.maxAmplitude ?: 0
      } catch (_: Exception) {
        0
      }
    }
  }

  private var mediaRecorder: MediaRecorder? = null
  private var dossierSegments: String? = null
  private var dureeSegmentMs: Long = 20000L
  private var debutSegmentActuel: Long = 0L
  private val handlerRotation = Handler(Looper.getMainLooper())
  private var rotationRunnable: Runnable? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_DEMARRER -> {
        dossierSegments = intent.getStringExtra(EXTRA_DOSSIER)
        dureeSegmentMs = intent.getLongExtra(EXTRA_DUREE_SEGMENT_MS, 20000L)
        demarrerPremierPlan()
        demarrerNouveauSegment()
        planifierRotation()
      }
      ACTION_PAUSE -> {
        annulerRotation()
        finaliserSegmentActuel()
        enPause = true
      }
      ACTION_REPRENDRE -> {
        enPause = false
        demarrerNouveauSegment()
        planifierRotation()
      }
      ACTION_ARRETER -> {
        annulerRotation()
        finaliserSegmentActuel()
        enCours = false
        enPause = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  private fun demarrerPremierPlan() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        val canal = NotificationChannel(CHANNEL_ID, "Enregistrement Aurore Mobile", NotificationManager.IMPORTANCE_LOW)
        canal.description = "Notification affichee pendant un enregistrement audio."
        manager.createNotificationChannel(canal)
      }
    }
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Aurore Mobile")
      .setContentText("Enregistrement en cours")
      .setOngoing(true)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    enCours = true
    derniereErreur = null
  }

  private fun cheminSegmentActuel(numero: Int): String {
    return "${dossierSegments}/segment-$numero.aac"
  }

  private fun demarrerNouveauSegment() {
    val dossier = dossierSegments ?: return
    try {
      File(dossier).mkdirs()
      val numero = prochainNumero
      val chemin = cheminSegmentActuel(numero)
      val recorder = MediaRecorder()
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.AAC_ADTS)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioEncodingBitRate(32000)
      recorder.setAudioSamplingRate(44100)
      recorder.setOutputFile(chemin)
      recorder.prepare()
      recorder.start()
      mediaRecorder = recorder
      debutSegmentActuel = System.currentTimeMillis()
    } catch (e: Exception) {
      derniereErreur = e.message ?: e.javaClass.simpleName
    }
  }

  /** Arrete le MediaRecorder courant et publie le segment termine - appele
   * a chaque rotation, a la pause, et a l'arret final. */
  private fun finaliserSegmentActuel() {
    val recorder = mediaRecorder ?: return
    val numero = prochainNumero
    val chemin = cheminSegmentActuel(numero)
    val dureeMs = System.currentTimeMillis() - debutSegmentActuel
    try {
      recorder.stop()
    } catch (_: Exception) {
      // Segment trop court (quelques dizaines de ms) - le fichier peut etre
      // invalide, le JS verifiera sa taille avant de le chiffrer.
    }
    try {
      recorder.release()
    } catch (_: Exception) {
    }
    mediaRecorder = null
    prochainNumero++

    synchronized(verrouSegments) {
      segmentsTermines.add(mapOf("chemin" to chemin, "dureeMs" to dureeMs, "numero" to numero))
    }
  }

  private fun planifierRotation() {
    val runnable = object : Runnable {
      override fun run() {
        if (!enCours || enPause) return
        finaliserSegmentActuel()
        demarrerNouveauSegment()
        handlerRotation.postDelayed(this, dureeSegmentMs)
      }
    }
    rotationRunnable = runnable
    handlerRotation.postDelayed(runnable, dureeSegmentMs)
  }

  private fun annulerRotation() {
    rotationRunnable?.let { handlerRotation.removeCallbacks(it) }
    rotationRunnable = null
  }

  fun niveauSonore(): Int = niveauSonoreActuel(mediaRecorder)

  override fun onDestroy() {
    annulerRotation()
    finaliserSegmentActuel()
    enCours = false
    instance = null
    super.onDestroy()
  }
}
