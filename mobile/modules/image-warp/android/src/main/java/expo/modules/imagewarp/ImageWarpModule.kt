package expo.modules.imagewarp

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Redressement de perspective (Prompt 5, objectif A) - voir
 * docs/lot10/05-scan.md : aucune bibliotheque de scan tierce (Google ML Kit
 * envoie de la telemetrie, voir ce document) - un simple appel a l'API
 * standard d'Android (`Matrix.setPolyToPoly`, dans le SDK Android lui-meme
 * depuis toujours, zero dependance externe) suffit a transformer les 4
 * coins choisis par l'utilisateur en un rectangle, exactement comme le
 * ferait une bibliotheque de "scan" classique - sans rien a auditer.
 */
private const val DIMENSION_MAX_PX = 1800.0

class ImageWarpModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ImageWarp")

    // 4 coins dans l'ordre haut-gauche, haut-droit, bas-droit, bas-gauche,
    // en coordonnees PIXEL de l'image source (jamais des coordonnees ecran -
    // c'est a l'appelant JS de convertir avant d'appeler cette fonction).
    AsyncFunction("redresser") { cheminSource: String, coins: List<Map<String, Double>>, cheminDestination: String ->
      redresserImage(cheminSource, coins, cheminDestination)
    }
  }

  private fun redresserImage(cheminSource: String, coins: List<Map<String, Double>>, cheminDestination: String): String {
    require(coins.size == 4) { "4 coins attendus (haut-gauche, haut-droit, bas-droit, bas-gauche)." }
    val source = BitmapFactory.decodeFile(cheminSource)
      ?: throw IllegalStateException("Image source illisible: $cheminSource")

    try {
      val points = coins.map { Pair(it["x"] ?: 0.0, it["y"] ?: 0.0) }
      val (hg, hd, bd, bg) = points

      // Dimensions cibles = moyenne des cotes opposes, plafonnees pour
      // garder une taille de fichier raisonnable (contrainte du prompt) -
      // jamais la taille brute de la photo source (souvent bien plus
      // grande que necessaire pour un document).
      val largeur = min(max(distance(hg, hd), distance(bg, bd)), DIMENSION_MAX_PX).toInt().coerceAtLeast(1)
      val hauteur = min(max(distance(hg, bg), distance(hd, bd)), DIMENSION_MAX_PX * 1.6).toInt().coerceAtLeast(1)

      val src = floatArrayOf(
        hg.first.toFloat(), hg.second.toFloat(),
        hd.first.toFloat(), hd.second.toFloat(),
        bd.first.toFloat(), bd.second.toFloat(),
        bg.first.toFloat(), bg.second.toFloat()
      )
      val dst = floatArrayOf(
        0f, 0f,
        largeur.toFloat(), 0f,
        largeur.toFloat(), hauteur.toFloat(),
        0f, hauteur.toFloat()
      )

      val matrice = Matrix()
      matrice.setPolyToPoly(src, 0, dst, 0, 4)

      val resultat = Bitmap.createBitmap(largeur, hauteur, Bitmap.Config.ARGB_8888)
      try {
        val canvas = Canvas(resultat)
        canvas.drawColor(Color.WHITE)
        val peinture = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        canvas.drawBitmap(source, matrice, peinture)

        File(cheminDestination).outputStream().use { sortie ->
          resultat.compress(Bitmap.CompressFormat.JPEG, 85, sortie)
        }
      } finally {
        resultat.recycle()
      }
      return cheminDestination
    } finally {
      source.recycle()
    }
  }

  private fun distance(a: Pair<Double, Double>, b: Pair<Double, Double>): Double =
    hypot(a.first - b.first, a.second - b.second)
}
