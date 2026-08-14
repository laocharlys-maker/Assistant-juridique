# Domaines de confiance Tavily — Recherche de jurisprudence vs Recherche juridique

Le module "Recherche juridique / Jurisprudence" d'Aurore couvre en réalité
deux actions distinctes (`type_action` dans `routes/webActions.ts`), qui
interrogent Tavily en complément du RAG pgvector (`JurisprudenceChunk`,
`services/rag.ts` — inchangé par ce qui suit) chacune avec ses **propres**
listes de domaines de confiance, volontairement jamais partagées :

| | Recherche de jurisprudence | Recherche juridique |
|---|---|---|
| Cherche | Des **décisions de justice** | Des **textes officiels et de la doctrine** |
| Fichier des domaines | `services/jurisprudence/domainesConfiance.ts` | `services/recherche-juridique/domainesConfiance.ts` |
| Catégories | Bénin, OHADA/CCJA, France, Afrique francophone élargie | Bénin, OHADA, doctrine/droit comparé, France |
| Exemple de domaine | `juricaf.org`, `coursupreme.bj` (bases d'arrêts) | `sgg.gouv.bj` (journal officiel), `legifrance.gouv.fr` (textes) |
| Seuil de secours | `JURISPRUDENCE_SEUIL_SOURCES_MINIMUM` (3 par défaut) | `RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM` (3 par défaut) |

## Pourquoi deux listes distinctes

Une base de jurisprudence (JURICAF, la Cour Suprême, la CCJA...) et un site
de textes officiels/doctrine (journal officiel, Légifrance, Cairn...) ne
répondent pas au même besoin : une question de droit général ("quelles
sont les conditions de création d'une SARL au Bénin ?") n'appelle aucune
décision de justice précise, et une recherche de jurisprudence sur un thème
ne doit pas se retrouver polluée par des articles de doctrine génériques.
Partager une même liste de domaines entre les deux actions aurait fait
remonter des sources hors sujet dans l'une ou l'autre, dégradant la
pertinence des deux.

## Mécanisme commun

Les deux modules partagent en revanche le même **algorithme** de recherche
(`services/tavilyCategorise.ts`) : un appel Tavily parallèle par catégorie
(`include_domains` restreint à la liste de la catégorie), puis un appel de
secours sans restriction de domaine uniquement si le nombre total de
sources récupérées (toutes catégories confondues, après déduplication par
URL) reste sous le seuil configuré. Un échec ou une absence de résultat sur
une catégorie ne bloque jamais les autres catégories ni la génération
(`searchWeb()` ne lève jamais d'exception, voir `services/tavily.ts`). La
couverture par catégorie est journalisée à chaque recherche (`console.log`,
préfixe `[jurisprudence-tavily]` ou `[recherche-juridique-tavily]`).
