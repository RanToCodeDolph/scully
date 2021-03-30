import { DOCUMENT } from '@angular/common';
import { HttpBackend, XhrFactory } from '@angular/common/http';
import { ResourceLoader } from '@angular/compiler';
import {
  APP_INITIALIZER,
  Compiler,
  CompilerFactory,
  Injectable,
  NgModuleFactory,
  Provider,
  StaticProvider,
  Type,
} from '@angular/core';
import { platformDynamicServer, renderModuleFactory } from '@angular/platform-server';
import {
  findPlugin,
  HandledRoute,
  loadConfig,
  registerPlugin,
  renderRoute,
  scullyConfig,
  ScullyConfig,
  startWorkerListener,
  Tasks,
  WriteToStorage,
} from '@scullyio/scully';
import { readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { URL } from 'url';
import { version } from 'yargs';
// tslint:disable-next-line: ordered-imports
import 'zone.js/dist/zone-node';
// tslint:disable-next-line: ordered-imports
import 'zone.js/dist/task-tracking';

let config: Promise<ScullyConfig>;
const globalSetup: {
  rawHtml?: string;
} = {};
const executePluginsForRoute = findPlugin(renderRoute);
const writeToFs = findPlugin(WriteToStorage);
const universalRenderRunner = Symbol('universalRender');

async function init(path) {
  const extraProviders: StaticProvider[] = [
    { provide: APP_INITIALIZER, multi: true, useFactory: domContentLoadedFactory, deps: [DOCUMENT] },
    ,
  ];
  const { config: myConfig } = await import(path);
  config = loadConfig(await myConfig);

  const lazymodule = await import('../../apps/universal-sample/src/main.universal');
  const userModule = lazymodule.AppUniversalModule;

  globalSetup.rawHtml = readFileSync(join(process.cwd(), './dist/apps/universal-sample/index.html')).toString();

  async function universalRenderPlugin(route: HandledRoute) {
    await config;
    try {
      const url = `http://localhost/${route.route}`;
      const window: Partial<Window> = {
        dispatchEvent: (...x: any[]) => undefined,
        location: (new URL(url) as unknown) as Location,
      };
      globalThis.window = window as Window & typeof globalThis;
      const options = {
        url,
        document: globalSetup.rawHtml,
      };
      window['scullyVersion'] = version;
      window['ScullyIO-exposed'] = undefined;
      window['ScullyIO-injected'] = undefined;
      if (route.config && route.config.manualIdleCheck) {
        route.exposeToPage = route.exposeToPage || {};
        route.exposeToPage.manualIdle = true;
      }

      if (scullyConfig.inlineStateOnly) {
        route.injectToPage = route.injectToPage || {};
        route.injectToPage.inlineStateOnly = true;
      }

      if (route.exposeToPage !== undefined) {
        window['ScullyIO-exposed'] = route.exposeToPage;
      }
      if (route.injectToPage !== undefined) {
        window['ScullyIO-injected'] = route.injectToPage;
      }
      window['ScullyIO'] = 'running';

      const factory = await getFactory(userModule);
      const result = await renderModuleFactory(factory, {
        document: globalSetup.rawHtml,
        url: `http://localhost/${route.route}`,
        extraProviders,
      });
      return result;
    } catch (e) {
      console.log(e);
    }
    return 'oops';
  }
  registerPlugin('scullySystem', universalRenderRunner, universalRenderPlugin);
  return 'init done ' + process.pid;
}

const factoryCacheMap = new Map<Type<{}>, NgModuleFactory<{}>>();
async function getFactory(moduleOrFactory: Type<{}> | NgModuleFactory<{}>): Promise<NgModuleFactory<{}>> {
  // If module has been compiled AoT
  if (moduleOrFactory instanceof NgModuleFactory) {
    return moduleOrFactory;
  } else {
    // we're in JIT mode
    if (!factoryCacheMap.has(moduleOrFactory)) {
      // Compile the module and cache it
      factoryCacheMap.set(moduleOrFactory, await getCompiler().compileModuleAsync(moduleOrFactory));
    }
    return factoryCacheMap.get(moduleOrFactory);
  }
}

function getCompiler(): Compiler {
  const compilerFactory: CompilerFactory = platformDynamicServer().injector.get(CompilerFactory);
  return compilerFactory.createCompiler([{ providers: [{ provide: ResourceLoader, useClass: FileLoader, deps: [] }] }]);
}

class FileLoader implements ResourceLoader {
  get(url: string): Promise<string> {
    return readFile(url, 'utf-8');
  }
}

if (typeof process.send === 'function') {
  const availableTasks: Tasks = {
    init,
    render: async (ev: HandledRoute) => {
      ev.renderPlugin = universalRenderRunner;
      const html = await executePluginsForRoute(ev);
      await writeToFs(ev.route, html);
    },
  } as const;

  startWorkerListener(availableTasks);
}

export function domContentLoadedFactory(doc: Document): () => Promise<void> {
  return () =>
    new Promise((resolve, _reject) => {
      if (doc.readyState === 'complete' || doc.readyState === 'interactive') {
        resolve();

        return;
      }

      const contentLoaded = () => {
        doc.removeEventListener('DOMContentLoaded', contentLoaded);
        resolve();
      };

      doc.addEventListener('DOMContentLoaded', contentLoaded);
    });
}
