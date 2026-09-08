(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Kana = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/**
 * Kana: lectura de básculas Torrey (y similares) desde el navegador con Web Serial.
 *
 * Piezas:
 *   parsearTorrey       texto de una trama -> { kg, bruto, unidad, estable }
 *   Estabilizador       máquina de estados pura: cuándo un peso está quieto y cuándo se retiró
 *   SerialTorrey        transporte Web Serial (abre el puerto, sondea con "P", lee)
 *   TransporteSimulado  la misma interfaz sin hardware, para pruebas y demos
 *   Bascula             lo une todo y emite eventos: peso, estable, retirado, estado, trama, aviso
 *
 * Sin dependencias. ESM en src/, UMD en dist/.
 */

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FACTOR_A_KG = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.028349523 };

/**
 * Interpreta una línea de la báscula.
 *
 * Acepta los formatos habituales de Torrey y de la familia "ST,GS,+ 1.250 kg":
 * con o sin banderas de estabilidad (ST estable / US inestable), con o sin
 * signo, con o sin unidad, con punto o coma decimal. Devuelve null si no hay
 * ningún número en la línea.
 *
 * @param {string} linea
 * @returns {{kg:number, bruto:number, unidad:string, unidadDeclarada:string|null, estable:boolean|null, texto:string}|null}
 */
function parsearTorrey(linea) {
  const texto = String(linea == null ? '' : linea).trim();
  if (!texto) return null;
  const mayus = texto.toUpperCase();

  let estable = null;
  if (/(^|[^A-Z])ST([^A-Z]|$)/.test(mayus)) estable = true;
  else if (/(^|[^A-Z])US([^A-Z]|$)/.test(mayus)) estable = false;

  const m = mayus.match(/([+-])?\s*(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  let bruto = parseFloat(m[2].replace(',', '.'));
  if (!Number.isFinite(bruto)) return null;
  if (m[1] === '-') bruto = -bruto;

  let unidadDeclarada = null;
  const u = mayus.match(/(^|[^A-Z])(KG|LB|OZ|G)([^A-Z]|$)/);
  if (u) unidadDeclarada = u[2].toLowerCase();
  const unidad = unidadDeclarada || 'kg';
  const kg = bruto * FACTOR_A_KG[unidad];
  return { kg, bruto, unidad, unidadDeclarada, estable, texto };
}

// ---------------------------------------------------------------------------
// Estabilizador
// ---------------------------------------------------------------------------

/**
 * Decide, lectura a lectura, cuándo un paquete está quieto sobre el plato y
 * cuándo se retiró. No usa temporizadores: recibe la marca de tiempo de cada
 * lectura, así se prueba sin esperar y se integra con cualquier reloj.
 *
 * Los valores por defecto salieron de básculas Torrey en producción: dos
 * lecturas que difieren menos de 3 g arrancan la espera de 800 ms; al
 * cumplirse se captura. Se considera retirado cuando el peso baja de 20 g o
 * cae por debajo del 60 % de lo capturado (para que un segundo paquete no
 * se cuente encima del primero).
 */
class Estabilizador {
  /**
   * @param {{umbral?:number, espera?:number, minimo?:number, fraccionRetiro?:number, usarFlag?:boolean}} [o]
   *   umbral   diferencia máxima entre lecturas para considerarlas iguales (kg)
   *   espera   ms que el peso debe mantenerse quieto antes de capturar
   *   minimo   por debajo de esto el plato está vacío (kg)
   *   fraccionRetiro  bajar de esta fracción del capturado cuenta como retirado
   *   usarFlag si la báscula manda ST/US, ST cuenta como lectura estable
   */
  constructor(o = {}) {
    this.umbral = o.umbral ?? 0.003;
    this.espera = o.espera ?? 800;
    this.minimo = o.minimo ?? 0.020;
    this.fraccionRetiro = o.fraccionRetiro ?? 0.60;
    this.usarFlag = o.usarFlag ?? true;
    this.reset();
  }

  reset() {
    this.ultimo = 0;
    this.inicioEstable = null;
    this.capturado = 0;
    this.agregado = false;
  }

  /** ¿Hay un paquete ya capturado esperando a que lo retiren? */
  get esperandoRetiro() { return this.agregado; }

  /**
   * Alimenta una lectura y devuelve los eventos que produce.
   * @param {number} kg
   * @param {number} [ahora]  marca de tiempo en ms
   * @param {boolean|null} [flagEstable]  ST/US de la báscula, si lo manda
   * @returns {Array<{tipo:'vacio'|'pesando'|'estabilizando'|'estable'|'retirado', kg:number}>}
   */
  alimentar(kg, ahora = Date.now(), flagEstable = null) {
    const bajadaRelativa = this.agregado && this.capturado > 0 && kg < this.capturado * this.fraccionRetiro;
    if (kg <= this.minimo || bajadaRelativa) {
      const habia = this.agregado;
      const cap = this.capturado;
      this.reset();
      return habia ? [{ tipo: 'retirado', kg: cap }] : [{ tipo: 'vacio', kg }];
    }
    if (this.agregado) return [];

    const diff = Math.abs(kg - this.ultimo);
    this.ultimo = kg;
    const quieto = diff < this.umbral || (this.usarFlag && flagEstable === true);
    if (!quieto) {
      this.inicioEstable = null;
      return [{ tipo: 'pesando', kg }];
    }
    if (this.inicioEstable == null) {
      this.inicioEstable = ahora;
      return [{ tipo: 'estabilizando', kg }];
    }
    if (ahora - this.inicioEstable >= this.espera) {
      this.agregado = true;
      this.capturado = kg;
      return [{ tipo: 'estable', kg }];
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Transportes
// ---------------------------------------------------------------------------

/**
 * Transporte Web Serial. La Torrey no transmite sola: hay que pedirle el peso
 * con "P\r\n" cada tanto. Si un write falla y no se suelta el writer, el lock
 * queda tomado y la báscula enmudece sin avisar; por eso se suelta siempre.
 */
class SerialTorrey {
  /**
   * @param {{baudRate?:number, dataBits?:number, stopBits?:number, parity?:string, sondeo?:number, comandoSondeo?:string}} [o]
   */
  constructor(o = {}) {
    this.baudRate = o.baudRate ?? 115200;
    this.dataBits = o.dataBits ?? 8;
    this.stopBits = o.stopBits ?? 1;
    this.parity = o.parity ?? 'none';
    this.sondeo = o.sondeo ?? 500;            // ms; 0 = la báscula transmite sola
    this.comandoSondeo = o.comandoSondeo ?? 'P\r\n';
    this.puerto = null;
    this._lector = null;
    this._timer = null;
    this._cerrando = false;
  }

  static get disponible() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  async pedirPuerto(filtros) {
    if (!SerialTorrey.disponible) throw new Error('Web Serial no está disponible: usa Chrome o Edge de escritorio');
    return navigator.serial.requestPort(filtros ? { filters: filtros } : undefined);
  }

  async puertosRecordados() {
    if (!SerialTorrey.disponible) return [];
    try { return await navigator.serial.getPorts(); } catch { return []; }
  }

  /**
   * Abre el puerto y empieza a leer. `onTexto` recibe cada fragmento que llega;
   * `onCierre` se llama una vez si la conexión se cae sola.
   */
  async abrir(puerto, onTexto, onCierre) {
    await puerto.open({ baudRate: this.baudRate, dataBits: this.dataBits, stopBits: this.stopBits, parity: this.parity });
    this.puerto = puerto;
    this._cerrando = false;
    this._loop(onTexto, onCierre);
    if (this.sondeo > 0) {
      const enc = new TextEncoder();
      this._timer = setInterval(async () => {
        if (!this.puerto || !this.puerto.writable) return;
        let w = null;
        try { w = this.puerto.writable.getWriter(); await w.write(enc.encode(this.comandoSondeo)); }
        catch { /* la lectura seguirá; el siguiente sondeo reintenta */ }
        finally { if (w) { try { w.releaseLock(); } catch { /* ya suelto */ } } }
      }, this.sondeo);
    }
  }

  async _loop(onTexto, onCierre) {
    const dec = new TextDecoder();
    while (!this._cerrando && this.puerto && this.puerto.readable) {
      this._lector = this.puerto.readable.getReader();
      try {
        for (;;) {
          const r = await this._lector.read();
          if (r.done) break;
          try { onTexto(dec.decode(r.value)); } catch { /* un error de quien escucha no mata la lectura */ }
        }
      } catch {
        break;
      } finally {
        try { this._lector.releaseLock(); } catch { /* ya suelto */ }
      }
    }
    if (!this._cerrando) {
      const caido = this.puerto;
      await this.cerrar(false);
      onCierre(caido);
    }
  }

  async cerrar(cerrarPuerto = true) {
    this._cerrando = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._lector) { try { await this._lector.cancel(); } catch { /* ya cerrado */ } this._lector = null; }
    if (this.puerto && cerrarPuerto) { try { await this.puerto.close(); } catch { /* ya cerrado */ } }
    if (cerrarPuerto) this.puerto = null;
  }
}

/**
 * Báscula de mentira con la misma interfaz que SerialTorrey. Emite tramas
 * "ST,GS,+ 1.250 kg" cada `intervalo` ms con un poco de ruido; al colocar un
 * peso manda unas lecturas inestables (US) antes de asentarse.
 */
class TransporteSimulado {
  constructor(o = {}) {
    this.intervalo = o.intervalo ?? 250;
    this.ruido = o.ruido ?? 0.001;
    this.lecturasAsentando = o.lecturasAsentando ?? 3;
    this.pesoReal = 0;
    this._asentando = 0;
    this._timer = null;
    this._onTexto = null;
  }

  static get disponible() { return true; }
  async pedirPuerto() { return { simulado: true }; }
  async puertosRecordados() { return [{ simulado: true }]; }

  async abrir(_puerto, onTexto) {
    this._onTexto = onTexto;
    this._timer = setInterval(() => this._tick(), this.intervalo);
  }

  _tick() {
    if (!this._onTexto) return;
    const inestable = this._asentando > 0;
    if (inestable) this._asentando--;
    const ruido = (Math.random() * 2 - 1) * this.ruido * (inestable ? 8 : 1);
    const kg = this.pesoReal > 0 ? Math.max(0, this.pesoReal + ruido) : 0;
    const signo = kg < 0 ? '-' : '+';
    this._onTexto(`${inestable ? 'US' : 'ST'},GS,${signo}${Math.abs(kg).toFixed(3).padStart(8, ' ')} kg\r\n`);
  }

  /** Pone un paquete en el plato. */
  colocar(kg) { this.pesoReal = kg; this._asentando = this.lecturasAsentando; }
  /** Vacía el plato. */
  retirar() { this.pesoReal = 0; this._asentando = 0; }
  /** Simula que el cable se desconecta. */
  caer() { const cb = this._onCierre; this.cerrar(); if (cb) cb({ simulado: true }); }

  async cerrar() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._onTexto = null;
  }
}

// ---------------------------------------------------------------------------
// Báscula
// ---------------------------------------------------------------------------

const ESTADOS = ['desconectada', 'conectando', 'conectada', 'reconectando'];

/**
 * La báscula como fuente de eventos.
 *
 *   const b = new Bascula();
 *   b.on('peso',     p => mostrar(p.kg));
 *   b.on('estable',  p => agregar(p.kg));
 *   b.on('retirado', () => listo());
 *   await b.conectar();
 *
 * Eventos: 'peso' {kg, bruto, unidad, estable}, 'fase' {fase, kg}, 'estable' {kg},
 * 'retirado' {kg}, 'captura' {kg, manual}, 'estado' {estado, mensaje}, 'trama' {texto},
 * 'aviso' {tipo, mensaje}, 'error' {error}.
 */
class Bascula {
  /**
   * @param {object} [o]  opciones de SerialTorrey y Estabilizador, más:
   *   transporte  instancia alternativa (p. ej. TransporteSimulado)
   *   parser      función texto -> lectura (por defecto parsearTorrey)
   *   throttle    ms mínimos entre procesados del buffer (200)
   *   recordar    recordar el puerto para reconectar sola al volver (true)
   *   clave       clave de localStorage para lo anterior ('kana:auto')
   *   filtros     filtros de puerto para requestPort (p. ej. [{usbVendorId: 0x0403}])
   *   reintentos  intentos de reconexión si la conexión se cae (3)
   */
  constructor(o = {}) {
    this.opciones = o;
    this.transporte = o.transporte || new SerialTorrey(o);
    this.parser = o.parser || parsearTorrey;
    this.estab = new Estabilizador(o);
    this.throttle = o.throttle ?? 200;
    this.recordar = o.recordar ?? true;
    this.clave = o.clave || 'kana:auto';
    this.reintentos = o.reintentos ?? 3;
    this.filtros = o.filtros;

    this.estado = 'desconectada';
    this.peso = 0;
    this.estable = false;
    this.ultimaLectura = null;
    this.quisoConectar = false;

    this._oyentes = new Map();
    this._buffer = '';
    this._ultimoProcesado = 0;
    this._timerThrottle = null;
    this._timerEspera = null;
    this._avisoUnidad = false;
    this._puerto = null;

    this._escucharUsb();
  }

  static get soportada() { return SerialTorrey.disponible; }

  get conectada() { return this.estado === 'conectada'; }

  // ---- eventos ----

  on(tipo, fn) {
    if (!this._oyentes.has(tipo)) this._oyentes.set(tipo, new Set());
    this._oyentes.get(tipo).add(fn);
    return () => this.off(tipo, fn);
  }

  off(tipo, fn) { this._oyentes.get(tipo)?.delete(fn); }

  emitir(tipo, datos = {}) {
    const set = this._oyentes.get(tipo);
    if (!set) return;
    for (const fn of set) {
      try { fn(datos); } catch (error) { if (tipo !== 'error') this.emitir('error', { error }); }
    }
  }

  _setEstado(estado, mensaje = '') {
    if (!ESTADOS.includes(estado)) throw new Error(`estado desconocido: ${estado}`);
    this.estado = estado;
    this.emitir('estado', { estado, mensaje });
  }

  // ---- conexión ----

  /** Pide un puerto al usuario (o usa el dado) y conecta. */
  async conectar(puerto) {
    if (this.conectada) return true;
    this._setEstado('conectando');
    try {
      const p = puerto || await this.transporte.pedirPuerto(this.filtros);
      await this._abrir(p);
      this.quisoConectar = true;
      this._guardarRecuerdo(true);
      return true;
    } catch (error) {
      this._setEstado('desconectada', error && error.message ? error.message : 'No se pudo conectar');
      this.emitir('error', { error });
      return false;
    }
  }

  /** Intenta reconectar con un puerto ya autorizado, si el usuario lo dejó recordado. */
  async reconectar() {
    if (this.conectada) return true;
    if (this.recordar && !this._leerRecuerdo()) return false;
    const puertos = await this.transporte.puertosRecordados();
    for (const p of puertos) {
      try {
        await this._abrir(p);
        this.quisoConectar = true;
        this._setEstado('conectada', 'Báscula lista (reconectada sola)');
        return true;
      } catch { /* siguiente puerto */ }
    }
    return false;
  }

  async desconectar() {
    this.quisoConectar = false;
    this._guardarRecuerdo(false);
    await this._cerrar(true);
    this._setEstado('desconectada', 'Sin conexión');
  }

  async _abrir(puerto) {
    await this.transporte.abrir(puerto, (t) => this._onTexto(t), (caido) => this._onCierre(caido));
    this._puerto = puerto;
    this._buffer = '';
    this.estab.reset();
    this._avisoUnidad = false;
    this._setEstado('conectada', 'Coloca paquete');
  }

  async _cerrar(cerrarPuerto) {
    if (this._timerThrottle) { clearTimeout(this._timerThrottle); this._timerThrottle = null; }
    if (this._timerEspera) { clearTimeout(this._timerEspera); this._timerEspera = null; }
    await this.transporte.cerrar(cerrarPuerto);
    if (cerrarPuerto) this._puerto = null;
    this.peso = 0;
    this.estable = false;
    this.estab.reset();
    this._buffer = '';
  }

  async _onCierre(caido) {
    await this._cerrar(false);
    if (!this.quisoConectar) { this._setEstado('desconectada', 'Sin conexión'); return; }
    this._setEstado('reconectando', 'Se perdió la conexión. Reintentando…');
    for (let i = 1; i <= this.reintentos; i++) {
      await new Promise((r) => setTimeout(r, 1200 * i));
      if (this.conectada || !this.quisoConectar) return;
      try { await caido.close(); } catch { /* ya cerrado */ }
      try {
        await this._abrir(caido);
        this._setEstado('conectada', 'Báscula reconectada');
        return;
      } catch { /* siguiente intento */ }
    }
    this._setEstado('desconectada', 'No se pudo recuperar. Conéctala de nuevo.');
  }

  _escucharUsb() {
    if (!SerialTorrey.disponible || !navigator.serial.addEventListener) return;
    navigator.serial.addEventListener('disconnect', (ev) => {
      if (this.conectada && ev.target === this._puerto) {
        this._cerrar(false).then(() => this._setEstado('desconectada', 'Báscula desconectada (USB)'));
      }
    });
    navigator.serial.addEventListener('connect', async (ev) => {
      if (!this.conectada && this.quisoConectar) {
        try { await this._abrir(ev.target); } catch { /* el usuario vuelve a conectar */ }
      }
    });
  }

  _guardarRecuerdo(si) {
    if (!this.recordar || typeof localStorage === 'undefined') return;
    try { if (si) localStorage.setItem(this.clave, '1'); else localStorage.removeItem(this.clave); } catch { /* sin storage */ }
  }

  _leerRecuerdo() {
    if (typeof localStorage === 'undefined') return true;
    try { return localStorage.getItem(this.clave) === '1'; } catch { return false; }
  }

  // ---- lectura ----

  _onTexto(texto) {
    this._buffer += texto;
    this.emitir('trama', { texto });
    if (this._buffer.length > 2048) this._buffer = this._buffer.slice(-512);
    this._procesarBuffer();
  }

  /** Procesa como mucho una vez cada `throttle` ms y solo la última línea completa: filtra ráfagas. */
  _procesarBuffer() {
    const ahora = Date.now();
    const desde = ahora - this._ultimoProcesado;
    if (desde < this.throttle) {
      if (!this._timerThrottle) {
        this._timerThrottle = setTimeout(() => { this._timerThrottle = null; this._procesarBuffer(); }, this.throttle - desde);
      }
      return;
    }
    this._ultimoProcesado = ahora;
    const lineas = this._buffer.split(/[\r\n]+/);
    this._buffer = lineas.pop() || '';
    for (let i = lineas.length - 1; i >= 0; i--) {
      const l = lineas[i].trim();
      if (l) { this._procesarLinea(l, ahora); return; }
    }
  }

  _procesarLinea(linea, ahora) {
    const lectura = this.parser(linea);
    if (!lectura) return;
    this.ultimaLectura = lectura;
    this.peso = lectura.kg;
    if (lectura.unidadDeclarada && lectura.unidadDeclarada !== 'kg' && !this._avisoUnidad) {
      this._avisoUnidad = true;
      this.emitir('aviso', { tipo: 'unidad', mensaje: `La báscula está en ${lectura.unidadDeclarada}; los pesos se convierten a kg.` });
    }
    this.emitir('peso', lectura);
    this._alimentar(lectura.kg, ahora, lectura.estable);
  }

  _alimentar(kg, ahora, flag) {
    for (const ev of this.estab.alimentar(kg, ahora, flag)) {
      if (ev.tipo === 'estable') {
        this.estable = true;
        this.emitir('estable', { kg: ev.kg });
      } else if (ev.tipo === 'retirado') {
        this.estable = false;
        this.emitir('retirado', { kg: ev.kg });
      } else if (ev.tipo === 'estabilizando') {
        // La captura ocurre al llegar la siguiente lectura tras la espera; si la
        // báscula tarda en mandarla, este temporizador la fuerza con el último peso.
        if (this._timerEspera) clearTimeout(this._timerEspera);
        this._timerEspera = setTimeout(() => {
          this._timerEspera = null;
          if (this.conectada && !this.estab.esperandoRetiro && this.estab.inicioEstable != null) {
            this._alimentar(this.estab.ultimo, Date.now(), null);
          }
        }, this.estab.espera + 20);
      }
      this.emitir('fase', { fase: ev.tipo, kg: ev.kg });
    }
  }

  /** Captura manual del peso actual, estable o no. */
  capturar() {
    if (this.peso <= 0) return null;
    const kg = this.peso;
    this.emitir('captura', { kg, manual: true, estable: this.estable });
    return kg;
  }
}

/** Una báscula simulada lista para usar: `b.simulador.colocar(1.25)`. */
function basculaSimulada(o = {}) {
  const transporte = new TransporteSimulado(o);
  const b = new Bascula({ ...o, transporte });
  b.simulador = transporte;
  return b;
}

return { VERSION, parsearTorrey, Estabilizador, SerialTorrey, TransporteSimulado, Bascula, basculaSimulada };
}));
