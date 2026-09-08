<div align="center">
  <br/>

# Kana

**秤 · Básculas Torrey desde el navegador, con Web Serial y sin dependencias.**

<br/>

![Web Serial](https://img.shields.io/badge/web%20serial-chrome%20%2F%20edge-4285f4?style=for-the-badge&logo=googlechrome&logoColor=white)
[![CI](https://img.shields.io/github/actions/workflow/status/Chidaruma696/Kana/ci.yml?branch=main&style=for-the-badge&label=node%20--test)](https://github.com/Chidaruma696/Kana/actions)
![Sin dependencias](https://img.shields.io/badge/dependencias-0-1b150d?style=for-the-badge)
![Licencia MIT](https://img.shields.io/badge/licencia-MIT-1b150d?style=for-the-badge)

<br/>

*sondeo · parser con ST/US y unidad · estabilizador · reconexión · simulador*

</div>

---

> [!NOTE]
> Kana es la mitad JavaScript de un par: lee la báscula; **[Tohru](https://github.com/Chidaruma696/Tohru)** (Python) le pone código de barras a lo que pesó. Cada una vive sola.

<br/>

## ⚖️ Qué es

Una báscula Torrey conectada por USB aparece como puerto serie. Con Web Serial, Chrome y Edge de escritorio pueden hablarle sin drivers ni instaladores: la página pide el puerto, el usuario lo autoriza una vez, y a partir de ahí el peso llega en vivo. Kana empaqueta todo lo que hay que saber para que eso funcione de verdad en un mostrador:

| 🔌 Conexión | ⚖️ Lectura | 🎯 Captura |
| --- | --- | --- |
| Abre el puerto a 115200 8N1 y **sondea** con `P\r\n` cada 500 ms, porque la Torrey no transmite sola | Procesa solo la **última línea completa**, como mucho cada 200 ms, para filtrar ráfagas | **Estabilizador**: dos lecturas a menos de 3 g arrancan 800 ms de espera; al cumplirse, captura una sola vez |
| Suelta siempre el *writer* aunque falle el envío; si no, el puerto se bloquea y la báscula enmudece sin avisar | Lee las banderas **ST/US** y la **unidad**; si la báscula está en libras, avisa y convierte | Detecta el **retiro** (menos de 20 g, o menos del 60 % de lo capturado) para no contar el mismo paquete dos veces |
| **Reconecta sola** si se cae el cable, y recuerda el puerto para no pedirlo en cada visita | Expone la trama cruda para ver qué manda exactamente tu modelo | Captura manual cuando hace falta, marcando si el peso estaba estable |

Cada umbral salió de un problema real con una Torrey L-PCR en producción; están todos como opciones por si tu báscula pide otros.

<br/>

## 📲 Instalar

```bash
npm install kana-bascula
```

```js
import { Bascula } from 'kana-bascula';
```

O sin empaquetador, con el UMD (expone `window.Kana`):

```html
<script src="https://cdn.jsdelivr.net/gh/Chidaruma696/Kana@main/dist/kana.umd.js"></script>
```

<br/>

## 🧪 Uso

```js
import { Bascula } from 'kana-bascula';

const bascula = new Bascula();

bascula.on('peso',     p => pantalla.textContent = p.kg.toFixed(3));  // cada lectura
bascula.on('estable',  p => agregarPesada(p.kg));                     // una vez por paquete
bascula.on('retirado', () => mensaje('Coloca el siguiente'));
bascula.on('estado',   s => chip(s.estado, s.mensaje));               // conectada · reconectando · desconectada
bascula.on('aviso',    a => alert(a.mensaje));                        // p. ej. la báscula está en libras

botonConectar.onclick = () => bascula.conectar();     // pide el puerto al usuario
bascula.reconectar();                                  // al cargar: usa el puerto ya autorizado, si lo hay
```

### Sin báscula

El simulador tiene la misma interfaz y sirve para desarrollar, hacer demos y correr las pruebas:

```js
import { basculaSimulada } from 'kana-bascula';

const b = basculaSimulada({ intervalo: 250 });
await b.conectar();
b.simulador.colocar(1.25);   // manda unas lecturas inestables y luego se asienta
b.simulador.retirar();
b.simulador.caer();          // simula que el cable se desconecta
```

### Solo el estabilizador

Si ya tienes tu propia lectura del puerto, la lógica de captura es una clase pura sin temporizadores:

```js
import { Estabilizador } from 'kana-bascula';

const e = new Estabilizador({ umbral: 0.003, espera: 800, minimo: 0.020 });
for (const ev of e.alimentar(kg, Date.now(), flagST)) {
  if (ev.tipo === 'estable') capturar(ev.kg);
  if (ev.tipo === 'retirado') listo();
}
```

Abre `demo/index.html` en Chrome para verlo funcionar con la báscula real o con la simulada, ver las tramas crudas e imprimir etiquetas de prueba.

<br/>

## 🔧 API

### `new Bascula(opciones)`

| Opción | Default | Qué hace |
| --- | --- | --- |
| `baudRate`, `dataBits`, `stopBits`, `parity` | `115200`, `8`, `1`, `'none'` | Parámetros del puerto |
| `sondeo` | `500` | ms entre cada `P\r\n`; `0` si tu báscula transmite sola |
| `comandoSondeo` | `'P\r\n'` | Lo que se manda para pedir el peso |
| `umbral` | `0.003` | kg de diferencia máxima entre lecturas "iguales" |
| `espera` | `800` | ms quieto antes de capturar |
| `minimo` | `0.020` | kg por debajo de los cuales el plato está vacío |
| `fraccionRetiro` | `0.60` | Bajar de esta fracción del capturado cuenta como retiro |
| `usarFlag` | `true` | La bandera `ST` de la báscula cuenta como lectura quieta |
| `throttle` | `200` | ms mínimos entre procesados del buffer |
| `parser` | `parsearTorrey` | Función `texto → lectura` si tu trama es distinta |
| `filtros` | | Filtros para `requestPort`, p. ej. `[{ usbVendorId: 0x0403 }]` |
| `recordar` | `true` | Recuerda el puerto para `reconectar()` en la siguiente visita |
| `reintentos` | `3` | Intentos de reconexión si se cae la conexión |
| `transporte` | `SerialTorrey` | Otro transporte con la misma interfaz (`TransporteSimulado`) |

Métodos: `conectar(puerto?)`, `reconectar()`, `desconectar()`, `capturar()`, `on(evento, fn)` (devuelve la función para quitarlo), `off()`. Propiedades: `estado`, `conectada`, `peso`, `estable`, `ultimaLectura`. `Bascula.soportada` dice si el navegador tiene Web Serial.

Eventos: `peso` `{kg, bruto, unidad, estable}` · `fase` `{fase: vacio|pesando|estabilizando|estable|retirado, kg}` · `estable` `{kg}` · `retirado` `{kg}` · `captura` `{kg, manual}` · `estado` `{estado, mensaje}` · `trama` `{texto}` · `aviso` `{tipo, mensaje}` · `error` `{error}`.

### `parsearTorrey(linea)`

Acepta `ST,GS,+   1.250 kg`, `US,GS,-0,015 kg`, `1.250`, `1250 g`, `2.000 lb`. Devuelve `{ kg, bruto, unidad, unidadDeclarada, estable }` o `null` si la línea no trae un número. Libras, onzas y gramos se convierten a kg.

> [!IMPORTANT]
> Los modelos de Torrey no mandan todos la misma trama. Activa "mostrar tramas crudas" en la demo con tu báscula, mira qué llega, y si el parser por defecto no la entiende, pásale el tuyo con la opción `parser`. Si tu trama encaja, abre un issue con el ejemplo para incluirla.

<br/>

## 🔬 Desarrollo

```bash
git clone https://github.com/Chidaruma696/Kana.git
cd Kana
node --test test/        # parser, estabilizador y una pesada completa con el simulador
python scripts/build.py  # regenera dist/ (ESM + UMD) sin toolchain
```

La fuente es un solo archivo, `src/kana.js`. `dist/` se commitea para que el UMD sirva desde jsDelivr sin publicar.

<br/>

## ⚖️ Licencia

[MIT](LICENSE).

<br/>

<div align="center">

*Lo que pesa, pesa.*

秤 · はかり

</div>
