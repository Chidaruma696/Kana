import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearTorrey, Estabilizador, basculaSimulada, Bascula, TransporteSimulado } from '../src/kana.js';

// ---------------------------------------------------------------- parser

test('parsea la trama Torrey con banderas y unidad', () => {
  const r = parsearTorrey('ST,GS,+   1.250 kg');
  assert.equal(r.kg, 1.25);
  assert.equal(r.estable, true);
  assert.equal(r.unidad, 'kg');
});

test('US es inestable, coma decimal y negativo', () => {
  const r = parsearTorrey('US,GS,-0,015 kg');
  assert.equal(r.estable, false);
  assert.equal(r.kg, -0.015);
});

test('sin unidad asume kg y sin banderas deja estable en null', () => {
  const r = parsearTorrey('  1.250');
  assert.equal(r.kg, 1.25);
  assert.equal(r.unidadDeclarada, null);
  assert.equal(r.estable, null);
});

test('libras y gramos se convierten a kg', () => {
  assert.ok(Math.abs(parsearTorrey('2.000 lb').kg - 0.90718474) < 1e-6);
  assert.equal(parsearTorrey('1250 g').kg, 1.25);
  assert.equal(parsearTorrey('1250 g').unidadDeclarada, 'g');
});

test('líneas sin número devuelven null', () => {
  assert.equal(parsearTorrey(''), null);
  assert.equal(parsearTorrey('READY'), null);
  assert.equal(parsearTorrey(null), null);
});

// ---------------------------------------------------------------- estabilizador

test('captura tras la espera y detecta el retiro', () => {
  const e = new Estabilizador({ espera: 800, umbral: 0.003, minimo: 0.02 });
  assert.deepEqual(e.alimentar(0, 0), [{ tipo: 'vacio', kg: 0 }]);
  assert.deepEqual(e.alimentar(1.240, 100), [{ tipo: 'pesando', kg: 1.240 }]);
  assert.deepEqual(e.alimentar(1.250, 300), [{ tipo: 'pesando', kg: 1.250 }]);
  assert.deepEqual(e.alimentar(1.251, 500), [{ tipo: 'estabilizando', kg: 1.251 }]);
  assert.deepEqual(e.alimentar(1.251, 900), []);            // aún no pasan 800 ms
  assert.deepEqual(e.alimentar(1.252, 1400), [{ tipo: 'estable', kg: 1.252 }]);
  assert.deepEqual(e.alimentar(1.252, 1700), []);           // ya agregado: silencio
  assert.deepEqual(e.alimentar(0.010, 2000), [{ tipo: 'retirado', kg: 1.252 }]);
  assert.equal(e.esperandoRetiro, false);
});

test('un movimiento reinicia la espera', () => {
  const e = new Estabilizador({ espera: 800 });
  e.alimentar(1.0, 0);
  e.alimentar(1.0, 200);                                    // estabilizando
  assert.deepEqual(e.alimentar(1.1, 400), [{ tipo: 'pesando', kg: 1.1 }]);
  assert.deepEqual(e.alimentar(1.1, 600), [{ tipo: 'estabilizando', kg: 1.1 }]);
  assert.deepEqual(e.alimentar(1.1, 1000), []);
  assert.deepEqual(e.alimentar(1.1, 1500), [{ tipo: 'estable', kg: 1.1 }]);
});

test('bajar del 60 % del capturado cuenta como retiro aunque no llegue a cero', () => {
  const e = new Estabilizador({ espera: 100 });
  e.alimentar(2.0, 0); e.alimentar(2.0, 50); e.alimentar(2.0, 200);
  assert.equal(e.esperandoRetiro, true);
  assert.deepEqual(e.alimentar(1.0, 300), [{ tipo: 'retirado', kg: 2.0 }]);
});

test('la bandera ST de la báscula cuenta como lectura quieta', () => {
  const e = new Estabilizador({ espera: 100, umbral: 0.003 });
  assert.deepEqual(e.alimentar(1.0, 0, true), [{ tipo: 'estabilizando', kg: 1.0 }]);
  assert.deepEqual(e.alimentar(1.5, 200, true), [{ tipo: 'estable', kg: 1.5 }]);   // salto grande pero ST
  const sin = new Estabilizador({ espera: 100, usarFlag: false });
  sin.alimentar(1.0, 0, true);
  assert.deepEqual(sin.alimentar(1.5, 200, true), [{ tipo: 'pesando', kg: 1.5 }]);
});

// ---------------------------------------------------------------- báscula simulada (extremo a extremo)

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('una pesada completa con la báscula simulada', async () => {
  const b = basculaSimulada({ intervalo: 20, throttle: 10, espera: 120, ruido: 0.0005 });
  const estados = [];
  const estables = [];
  let retirado = 0;
  b.on('estado', (s) => estados.push(s.estado));
  b.on('estable', (p) => estables.push(p.kg));
  b.on('retirado', () => retirado++);

  assert.equal(await b.conectar(), true);
  assert.equal(b.conectada, true);
  b.simulador.colocar(1.25);
  await esperar(500);
  assert.equal(estables.length, 1, 'una sola captura por paquete');
  assert.ok(Math.abs(estables[0] - 1.25) < 0.01);
  assert.equal(b.estable, true);

  b.simulador.retirar();
  await esperar(100);
  assert.equal(retirado, 1);
  assert.equal(b.estable, false);

  b.simulador.colocar(0.8);
  await esperar(500);
  assert.equal(estables.length, 2, 'el segundo paquete se captura solo');

  await b.desconectar();
  assert.equal(b.estado, 'desconectada');
  assert.deepEqual(estados.slice(0, 2), ['conectando', 'conectada']);
});

test('captura manual y aviso de unidad', async () => {
  const t = new TransporteSimulado({ intervalo: 20 });
  const b = new Bascula({ transporte: t, throttle: 5, parser: (l) => parsearTorrey(l.replace('kg', 'lb')) });
  const avisos = [];
  b.on('aviso', (a) => avisos.push(a.tipo));
  await b.conectar();
  t.colocar(2.0);
  await esperar(120);
  assert.equal(avisos[0], 'unidad');
  assert.ok(b.peso > 0.8 && b.peso < 1.0, 'las libras se convirtieron a kg');
  const kg = b.capturar();
  assert.ok(kg > 0);
  await b.desconectar();
});

test('sin transporte real, conectar falla limpio en Node', async () => {
  const b = new Bascula({ recordar: false });
  assert.equal(Bascula.soportada, false);
  const errores = [];
  b.on('error', (e) => errores.push(e.error.message));
  assert.equal(await b.conectar(), false);
  assert.equal(b.estado, 'desconectada');
  assert.match(errores[0], /Web Serial/);
});
