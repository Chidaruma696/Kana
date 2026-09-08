[🇪🇸 Español](README.md)

<div align="center">
  <br/>

# Kana

**秤 · Torrey scales from the browser, with Web Serial and no dependencies.**

<br/>

![Web Serial](https://img.shields.io/badge/web%20serial-chrome%20%2F%20edge-4285f4?style=for-the-badge&logo=googlechrome&logoColor=white)
[![CI](https://img.shields.io/github/actions/workflow/status/Chidaruma696/Kana/ci.yml?branch=main&style=for-the-badge&label=node%20--test)](https://github.com/Chidaruma696/Kana/actions)
![No dependencies](https://img.shields.io/badge/dependencies-0-1b150d?style=for-the-badge)
![MIT License](https://img.shields.io/badge/license-MIT-1b150d?style=for-the-badge)

<br/>

*polling · parser with ST/US and unit · stabilizer · reconnection · simulator*

</div>

---

> [!NOTE]
> Kana is the JavaScript half of a pair: it reads the scale; **[Tohru](https://github.com/Chidaruma696/Tohru)** (Python) puts a barcode on whatever it weighed. Each one stands on its own.

<br/>

## ⚖️ What it is

A Torrey scale plugged in over USB shows up as a serial port. With Web Serial, desktop Chrome and Edge can talk to it with no drivers or installers: the page asks for the port, the user authorizes it once, and from then on the weight comes in live. Kana packages everything you need to know to make that actually work at a checkout counter:

| 🔌 Connection | ⚖️ Reading | 🎯 Capture |
| --- | --- | --- |
| Opens the port at 115200 8N1 and **polls** with `P\r\n` every 500 ms, because the Torrey doesn't transmit on its own | Processes only the **last complete line**, at most every 200 ms, to filter out bursts | **Stabilizer**: two readings within 3 g of each other start an 800 ms wait; once it elapses, it captures exactly once |
| Always releases the *writer* even if the write fails; otherwise the port locks up and the scale goes silent without warning | Reads the **ST/US** flags and the **unit**; if the scale is set to pounds, it warns you and converts | Detects **removal** (under 20 g, or under 60 % of what was captured) so the same package is never counted twice |
| **Reconnects on its own** if the cable drops, and remembers the port so it doesn't have to ask on every visit | Exposes the raw frame so you can see exactly what your model sends | Manual capture when you need it, flagging whether the weight was stable |

Every threshold came from a real problem with a Torrey L-PCR in production; they're all exposed as options in case your scale needs different ones.

<br/>

## 📲 Install

```bash
npm install kana-bascula
```

```js
import { Bascula } from 'kana-bascula';
```

Or without a bundler, using the UMD build (exposes `window.Kana`):

```html
<script src="https://cdn.jsdelivr.net/gh/Chidaruma696/Kana@main/dist/kana.umd.js"></script>
```

<br/>

## 🧪 Usage

```js
import { Bascula } from 'kana-bascula';

const bascula = new Bascula();

bascula.on('peso',     p => pantalla.textContent = p.kg.toFixed(3));  // every reading
bascula.on('estable',  p => agregarPesada(p.kg));                     // once per package
bascula.on('retirado', () => mensaje('Coloca el siguiente'));
bascula.on('estado',   s => chip(s.estado, s.mensaje));               // connected · reconnecting · disconnected
bascula.on('aviso',    a => alert(a.mensaje));                        // e.g. the scale is set to pounds

botonConectar.onclick = () => bascula.conectar();     // asks the user for the port
bascula.reconectar();                                  // on load: uses the already-authorized port, if any
```

### Without a scale

The simulator has the same interface and is handy for development, demos and running the tests:

```js
import { basculaSimulada } from 'kana-bascula';

const b = basculaSimulada({ intervalo: 250 });
await b.conectar();
b.simulador.colocar(1.25);   // sends a few unstable readings and then settles
b.simulador.retirar();
b.simulador.caer();          // simulates the cable being unplugged
```

### Just the stabilizer

If you already have your own port reader, the capture logic is a pure class with no timers:

```js
import { Estabilizador } from 'kana-bascula';

const e = new Estabilizador({ umbral: 0.003, espera: 800, minimo: 0.020 });
for (const ev of e.alimentar(kg, Date.now(), flagST)) {
  if (ev.tipo === 'estable') capturar(ev.kg);
  if (ev.tipo === 'retirado') listo();
}
```

Open `demo/index.html` in Chrome to see it working with a real or simulated scale, inspect the raw frames and print test labels.

<br/>

## 🔧 API

### `new Bascula(opciones)`

| Option | Default | What it does |
| --- | --- | --- |
| `baudRate`, `dataBits`, `stopBits`, `parity` | `115200`, `8`, `1`, `'none'` | Port parameters |
| `sondeo` | `500` | ms between each `P\r\n`; `0` if your scale transmits on its own |
| `comandoSondeo` | `'P\r\n'` | What gets sent to request the weight |
| `umbral` | `0.003` | Maximum difference in kg between two "equal" readings |
| `espera` | `800` | ms the weight must hold still before capturing |
| `minimo` | `0.020` | kg below which the platter counts as empty |
| `fraccionRetiro` | `0.60` | Dropping below this fraction of the captured weight counts as removal |
| `usarFlag` | `true` | The scale's `ST` flag counts as a stable reading |
| `throttle` | `200` | Minimum ms between buffer processing passes |
| `parser` | `parsearTorrey` | A `text → reading` function if your frame is different |
| `filtros` | | Filters for `requestPort`, e.g. `[{ usbVendorId: 0x0403 }]` |
| `recordar` | `true` | Remembers the port so `reconectar()` works on the next visit |
| `reintentos` | `3` | Reconnection attempts if the connection drops |
| `transporte` | `SerialTorrey` | Another transport with the same interface (`TransporteSimulado`) |

Methods: `conectar(puerto?)`, `reconectar()`, `desconectar()`, `capturar()`, `on(evento, fn)` (returns the function to remove the listener), `off()`. Properties: `estado`, `conectada`, `peso`, `estable`, `ultimaLectura`. `Bascula.soportada` tells you whether the browser has Web Serial.

Events: `peso` `{kg, bruto, unidad, estable}` · `fase` `{fase: vacio|pesando|estabilizando|estable|retirado, kg}` · `estable` `{kg}` · `retirado` `{kg}` · `captura` `{kg, manual}` · `estado` `{estado, mensaje}` · `trama` `{texto}` · `aviso` `{tipo, mensaje}` · `error` `{error}`.

### `parsearTorrey(linea)`

Accepts `ST,GS,+   1.250 kg`, `US,GS,-0,015 kg`, `1.250`, `1250 g`, `2.000 lb`. Returns `{ kg, bruto, unidad, unidadDeclarada, estable }`, or `null` if the line doesn't carry a number. Pounds, ounces and grams are converted to kg.

> [!IMPORTANT]
> Not every Torrey model sends the same frame. Turn on "show raw frames" in the demo with your scale, look at what comes in, and if the default parser doesn't understand it, pass your own through the `parser` option. If your frame does fit, open an issue with the example so it can be added.

<br/>

## 🔬 Development

```bash
git clone https://github.com/Chidaruma696/Kana.git
cd Kana
node --test test/        # parser, stabilizer and a full weighing cycle with the simulator
python scripts/build.py  # regenerates dist/ (ESM + UMD) with no toolchain
```

The source is a single file, `src/kana.js`. `dist/` is committed so the UMD build can be served from jsDelivr without publishing.

<br/>

## ⚖️ License

[MIT](LICENSE).

<br/>

<div align="center">

*What weighs, weighs.*

秤 · はかり

</div>
