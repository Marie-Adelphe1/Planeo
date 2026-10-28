# Planéo

Une PWA pour affiner vos idées avec l’IA, les transformer en feuille de route, tâches, checklists et rappels, puis suivre vos progrès avec des questionnaires qui recalculent le plan quand ça déraille.

Tout fonctionne avec des services gratuits.



## Ce que fait l’application

| Fonction | Comment |
|---|---|
| Discussion pour optimiser une idée | Atelier : l’IA reformule, pose des questions, challenge le périmètre |
| Synthèse en plan | Feuille de route avec étapes, attentes et dates limites, puis tâches avec checklists et rappels |
| Rappels | Notifications du navigateur, push sur téléphone via ntfy, export ou abonnement calendrier |
| Suivi | Questionnaire « réussite » si la tâche est finie à temps, « retard » si finie en retard, « échéance dépassée » si non faite |
| Recalcul | Report simple avec décalage en cascade, ou replanification par l’IA, toujours validée par vous avant application |
| Apprentissage | Les réponses aux suivis (estimations trop courtes, causes de retard…) sont transmises à l’IA pour calibrer les plans suivants |
| Sauvegarde | Export/import JSON, synchronisation multi-appareils via un Gist secret GitHub |

## Ressources gratuites utilisées

- **GitHub Pages** : hébergement.
- **IA**, au choix dans Réglages :
  - *Mode manuel* : copier-coller avec ChatGPT, Claude ou Gemini dans leurs versions gratuites. Aucune clé.
  - *Google Gemini* : clé gratuite sur [Google AI Studio](https://aistudio.google.com/apikey), modèles Flash. Quotas variables, et les échanges peuvent servir à améliorer les produits Google sur l’offre gratuite. Lisez leurs conditions, notamment pour l’Union européenne.
  - *Groq* et *OpenRouter* (modèles `:free`) : clés gratuites avec quotas.
  - *OpenAI* et *Anthropic* sont proposés mais payants à l’usage.
- **ntfy.sh** : notifications push gratuites sur téléphone, sans compte.
- **Gist GitHub** : sauvegarde, synchronisation et adresse d’abonnement calendrier.

## Réglages conseillés pour démarrer

1. **Réglages → Assistant IA** : choisissez Gemini ou Groq, collez la clé, puis « Tester la connexion ».
2. **Réglages → Rappels** : « Activer les notifications », puis générez un sujet ntfy et abonnez-vous-y dans l’app ntfy.
3. **Réglages → Sauvegarde** : créez un jeton GitHub avec la permission « Gists » (lecture et écriture), cochez la synchronisation automatique. Vous obtenez une adresse d’abonnement `.ics` à ajouter dans Google Agenda : vos tâches et leurs alarmes y apparaissent et suivent les replanifications.

## Sécurité et confidentialité

Ce qui est en place :

- **Aucun serveur** : vos données restent dans le navigateur (IndexedDB). Planéo demande au navigateur de ne pas les effacer automatiquement.
- **Verrou CSP** : le navigateur n’exécute que le code de l’app et ne laisse partir des données que vers les services prévus (fournisseurs d’IA, ntfy.sh, GitHub). Même en cas de faille, une clé ne pourrait pas être envoyée vers un site tiers.
- **Contrôle strict des données importées** (fichier JSON, Gist) : tout champ inattendu est corrigé ou rejeté avant d’entrer dans l’app.
- **Contenu de l’IA affiché comme du texte**, jamais exécuté ; toute modification proposée par l’IA attend votre validation.
- **Aucune ressource externe**


---

© Copyright, ceci est un mini projet de Marie-Adelphe A.
