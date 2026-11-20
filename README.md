# Campaign Loop

[Probar demo en el navegador](https://radusquinho.github.io/campaign-loop/)

Aplicación local de automatización de marketing para analizar campañas de Meta Ads, Google Ads y email, proponer variaciones y revisar experimentos A/B. Incluye 56 días de datos ficticios para Vértice Studio. Los datos propios importados quedan en un conjunto independiente.

**English overview** · Campaign analytics, automated recommendations and human-approved A/B experiments with simulated traffic.

La demo pública permite analizar campañas, importar y exportar CSV, aprobar propuestas y simular experimentos. Los cambios quedan en IndexedDB en el navegador de cada visitante. El análisis programado funciona mientras la demo permanece abierta. La demo comparte las reglas y el motor de experimentación con la versión local en Node.js y SQLite, que admite Ollama. `npm run build:pages` genera los archivos estáticos en `dist/`.

## Ejecutar en Windows

Requiere Node.js 24. Ejecuta `npm start` desde esta carpeta y abre [Campaign Loop](http://127.0.0.1:4387). Ejecuta `npm test` para comprobar validación, detección, cálculo de resultados y persistencia. SQLite se crea en `.data/`. Puedes elegir otra ubicación con `CAMPAIGN_LOOP_DATA` y otro puerto con `CAMPAIGN_LOOP_PORT`.

## Demostración

1. En **Resumen**, compara ingresos, gasto, coste por adquisición y ROAS por canal y periodo.
2. Pulsa **Ejecutar análisis**. Las reglas comparan dos periodos completos de siete días y aplican umbrales de cambio y mínimos de muestra. Volver a analizar las mismas filas conserva cada propuesta y su estado.
3. En **Automatización**, abre una propuesta para mostrar los valores observados, la hipótesis y el borrador de texto. Aprueba una prueba A/B.
4. En **Experimentos**, simula cinco lotes de 400 impresiones o visitas por grupo, según la métrica. La app espera a tener 2.000 observaciones por grupo antes de informar si gana el control, la variante o si el resultado es inconcluso. Usa un intervalo del 95 % para la diferencia de proporciones según el método de Newcombe basado en Wilson. El tráfico es sintético y se genera de forma reproducible. El tamaño de la muestra es fijo para la demo. [Referencia del método](https://pubmed.ncbi.nlm.nih.gov/9595617/)
5. En **Actividad**, muestra el historial de importaciones, análisis y decisiones. El análisis programado es opcional y se ejecuta cada 15 minutos mientras el servidor está abierto.

Desde **Datos** puedes descargar la plantilla e importar CSV con métricas agregadas. Cada combinación de fecha, canal y campaña es única. El importe se introduce en EUR y se guarda en céntimos. La aplicación no se conecta a plataformas publicitarias ni envía correos.

## Redacción con Ollama

Las reglas detectan y priorizan señales. Si tienes un modelo local instalado en Ollama, puedes configurarlo para redactar hipótesis, propuestas y borradores en el siguiente arranque. Se envían al modelo local el tipo de señal, el canal y el borrador base. Si el servicio falla o devuelve una estructura inválida, la propuesta se guarda con el borrador generado por reglas y muestra su origen. [Documentación de salidas estructuradas de Ollama](https://docs.ollama.com/capabilities/structured-outputs)

```powershell
$env:CAMPAIGN_LOOP_OLLAMA_MODEL = 'nombre-del-modelo-instalado'
npm start
```

## Para el CV

**Campaign Loop · Automatización de marketing**. Desarrollé una aplicación en JavaScript y SQLite que detecta anomalías en campañas, genera borradores de pruebas A/B con respaldo por reglas y Ollama opcional, y calcula resultados con tráfico simulado y aprobación humana.
