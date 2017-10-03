/// <reference path="..\services\services.ts" />
/// <reference path="utilities.ts"/>
/// <reference path="scriptInfo.ts"/>
/// <reference path="..\compiler\resolutionCache.ts"/>
/// <reference path="typingsCache.ts"/>
/// <reference path="..\compiler\builder.ts"/>

namespace ts.server {

    export enum ProjectKind {
        Inferred,
        Configured,
        External
    }

    /* @internal */
    export function countEachFileTypes(infos: ScriptInfo[]): FileStats {
        const result = { js: 0, jsx: 0, ts: 0, tsx: 0, dts: 0 };
        for (const info of infos) {
            switch (info.scriptKind) {
                case ScriptKind.JS:
                    result.js += 1;
                    break;
                case ScriptKind.JSX:
                    result.jsx += 1;
                    break;
                case ScriptKind.TS:
                    fileExtensionIs(info.fileName, Extension.Dts)
                        ? result.dts += 1
                        : result.ts += 1;
                    break;
                case ScriptKind.TSX:
                    result.tsx += 1;
                    break;
            }
        }
        return result;
    }

    function hasOneOrMoreJsAndNoTsFiles(project: Project) {
        const counts = countEachFileTypes(project.getScriptInfos());
        return counts.js > 0 && counts.ts === 0 && counts.tsx === 0;
    }

    export function allRootFilesAreJsOrDts(project: Project): boolean {
        const counts = countEachFileTypes(project.getRootScriptInfos());
        return counts.ts === 0 && counts.tsx === 0;
    }

    export function allFilesAreJsOrDts(project: Project): boolean {
        const counts = countEachFileTypes(project.getScriptInfos());
        return counts.ts === 0 && counts.tsx === 0;
    }

    /* @internal */
    export interface ProjectFilesWithTSDiagnostics extends protocol.ProjectFiles {
        projectErrors: ReadonlyArray<Diagnostic>;
    }

    export class UnresolvedImportsMap {
        readonly perFileMap = createMap<ReadonlyArray<string>>();
        private version = 0;

        public clear() {
            this.perFileMap.clear();
            this.version = 0;
        }

        public getVersion() {
            return this.version;
        }

        public remove(path: Path) {
            this.perFileMap.delete(path);
            this.version++;
        }

        public get(path: Path) {
            return this.perFileMap.get(path);
        }

        public set(path: Path, value: ReadonlyArray<string>) {
            this.perFileMap.set(path, value);
            this.version++;
        }
    }

    export interface PluginCreateInfo {
        project: Project;
        languageService: LanguageService;
        languageServiceHost: LanguageServiceHost;
        serverHost: ServerHost;
        config: any;
    }

    export interface PluginModule {
        create(createInfo: PluginCreateInfo): LanguageService;
        getExternalFiles?(proj: Project): string[];
    }

    export interface PluginModuleFactory {
        (mod: { typescript: typeof ts }): PluginModule;
    }

    /**
     * The project root can be script info - if root is present,
     * or it could be just normalized path if root wasnt present on the host(only for non inferred project)
     */
    export type ProjectRoot = ScriptInfo | NormalizedPath;
    /* @internal */
    export function isScriptInfo(value: ProjectRoot): value is ScriptInfo {
        return value instanceof ScriptInfo;
    }

    export abstract class Project implements LanguageServiceHost, ModuleResolutionHost {
        private rootFiles: ScriptInfo[] = [];
        private rootFilesMap: Map<ProjectRoot> = createMap<ProjectRoot>();
        private program: Program;
        private externalFiles: SortedReadonlyArray<string>;
        private missingFilesMap: Map<FileWatcher>;

        private cachedUnresolvedImportsPerFile = new UnresolvedImportsMap();
        private lastCachedUnresolvedImportsList: SortedReadonlyArray<string>;

        // wrapper over the real language service that will suppress all semantic operations
        protected languageService: LanguageService;

        public languageServiceEnabled = true;

        readonly trace?: (s: string) => void;
        readonly realpath?: (path: string) => string;

        /*@internal*/
        hasInvalidatedResolution: HasInvalidatedResolution;

        /*@internal*/
        resolutionCache: ResolutionCache;

        private builder: Builder;
        /**
         * Set of files names that were updated since the last call to getChangesSinceVersion.
         */
        private updatedFileNames: Map<true>;
        /**
         * Set of files that was returned from the last call to getChangesSinceVersion.
         */
        private lastReportedFileNames: Map<true>;
        /**
         * Last version that was reported.
         */
        private lastReportedVersion = 0;
        /**
         * Current project structure version.
         * This property is changed in 'updateGraph' based on the set of files in program
         */
        private projectStructureVersion = 0;
        /**
         * Current version of the project state. It is changed when:
         * - new root file was added/removed
         * - edit happen in some file that is currently included in the project.
         * This property is different from projectStructureVersion since in most cases edits don't affect set of files in the project
         */
        private projectStateVersion = 0;

        /*@internal*/
        hasChangedAutomaticTypeDirectiveNames = false;

        private typingFiles: SortedReadonlyArray<string>;

        public isNonTsProject() {
            this.updateGraph();
            return allFilesAreJsOrDts(this);
        }

        public isJsOnlyProject() {
            this.updateGraph();
            return hasOneOrMoreJsAndNoTsFiles(this);
        }

        public getCachedUnresolvedImportsPerFile_TestOnly() {
            return this.cachedUnresolvedImportsPerFile;
        }

        public static resolveModule(moduleName: string, initialDir: string, host: ServerHost, log: (message: string) => void): {} {
            const resolvedPath = normalizeSlashes(host.resolvePath(combinePaths(initialDir, "node_modules")));
            log(`Loading ${moduleName} from ${initialDir} (resolved to ${resolvedPath})`);
            const result = host.require(resolvedPath, moduleName);
            if (result.error) {
                const err = result.error.stack || result.error.message || JSON.stringify(result.error);
                log(`Failed to load module '${moduleName}': ${err}`);
                return undefined;
            }
            return result.module;
        }

        /*@internal*/
        constructor(
            /*@internal*/readonly projectName: string,
            readonly projectKind: ProjectKind,
            readonly projectService: ProjectService,
            private documentRegistry: DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            languageServiceEnabled: boolean,
            private compilerOptions: CompilerOptions,
            public compileOnSaveEnabled: boolean,
            /*@internal*/public directoryStructureHost: DirectoryStructureHost,
            rootDirectoryForResolution: string | undefined) {

            if (!this.compilerOptions) {
                this.compilerOptions = getDefaultCompilerOptions();
                this.compilerOptions.allowNonTsExtensions = true;
                this.compilerOptions.allowJs = true;
            }
            else if (hasExplicitListOfFiles || this.compilerOptions.allowJs) {
                // If files are listed explicitly or allowJs is specified, allow all extensions
                this.compilerOptions.allowNonTsExtensions = true;
            }

            this.setInternalCompilerOptionsForEmittingJsFiles();
            const host = this.projectService.host;
            if (host.trace) {
                this.trace = s => host.trace(s);
            }

            if (host.realpath) {
                this.realpath = path => host.realpath(path);
            }

            this.languageService = createLanguageService(this, this.documentRegistry);
            this.resolutionCache = createResolutionCache(this, rootDirectoryForResolution);
            if (!languageServiceEnabled) {
                this.disableLanguageService();
            }
            this.markAsDirty();
        }

        getCompilationSettings() {
            return this.compilerOptions;
        }

        getNewLine() {
            return this.directoryStructureHost.newLine;
        }

        getProjectVersion() {
            return this.projectStateVersion.toString();
        }

        getScriptFileNames() {
            if (!this.rootFiles) {
                return ts.emptyArray;
            }

            let result: string[] | undefined;
            this.rootFilesMap.forEach(value => {
                if (this.languageServiceEnabled || (isScriptInfo(value) && value.isScriptOpen())) {
                    // if language service is disabled - process only files that are open
                    (result || (result = [])).push(isScriptInfo(value) ? value.fileName : value);
                }
            });

            return addRange(result, this.typingFiles) || ts.emptyArray;
        }

        private getOrCreateScriptInfoAndAttachToProject(fileName: string) {
            const scriptInfo = this.projectService.getOrCreateScriptInfoNotOpenedByClient(fileName, this.directoryStructureHost);
            if (scriptInfo) {
                const existingValue = this.rootFilesMap.get(scriptInfo.path);
                if (existingValue !== scriptInfo && existingValue !== undefined) {
                    // This was missing path earlier but now the file exists. Update the root
                    this.rootFiles.push(scriptInfo);
                    this.rootFilesMap.set(scriptInfo.path, scriptInfo);
                }
                scriptInfo.attachToProject(this);
            }
            return scriptInfo;
        }

        getScriptKind(fileName: string) {
            const info = this.getOrCreateScriptInfoAndAttachToProject(fileName);
            return info && info.scriptKind;
        }

        getScriptVersion(filename: string) {
            const info = this.getOrCreateScriptInfoAndAttachToProject(filename);
            return info && info.getLatestVersion();
        }

        getScriptSnapshot(filename: string): IScriptSnapshot {
            const scriptInfo = this.getOrCreateScriptInfoAndAttachToProject(filename);
            if (scriptInfo) {
                return scriptInfo.getSnapshot();
            }
        }

        getCancellationToken() {
            return this.projectService.cancellationToken;
        }

        getCurrentDirectory(): string {
            return this.directoryStructureHost.getCurrentDirectory();
        }

        getDefaultLibFileName() {
            const nodeModuleBinDir = getDirectoryPath(normalizePath(this.projectService.host.getExecutingFilePath()));
            return combinePaths(nodeModuleBinDir, getDefaultLibFileName(this.compilerOptions));
        }

        useCaseSensitiveFileNames() {
            return this.directoryStructureHost.useCaseSensitiveFileNames;
        }

        readDirectory(path: string, extensions?: ReadonlyArray<string>, exclude?: ReadonlyArray<string>, include?: ReadonlyArray<string>, depth?: number): string[] {
            return this.directoryStructureHost.readDirectory(path, extensions, exclude, include, depth);
        }

        readFile(fileName: string): string | undefined {
            return this.directoryStructureHost.readFile(fileName);
        }

        fileExists(file: string): boolean {
            // As an optimization, don't hit the disks for files we already know don't exist
            // (because we're watching for their creation).
            const path = this.toPath(file);
            return !this.isWatchedMissingFile(path) && this.directoryStructureHost.fileExists(file);
        }

        resolveModuleNames(moduleNames: string[], containingFile: string, reusedNames?: string[]): ResolvedModuleFull[] {
            return this.resolutionCache.resolveModuleNames(moduleNames, containingFile, reusedNames, /*logChanges*/ true);
        }

        resolveTypeReferenceDirectives(typeDirectiveNames: string[], containingFile: string): ResolvedTypeReferenceDirective[] {
            return this.resolutionCache.resolveTypeReferenceDirectives(typeDirectiveNames, containingFile);
        }

        directoryExists(path: string): boolean {
            return this.directoryStructureHost.directoryExists(path);
        }

        getDirectories(path: string): string[] {
            return this.directoryStructureHost.getDirectories(path);
        }

        /*@internal*/
        toPath(fileName: string) {
            return this.projectService.toPath(fileName);
        }

        /*@internal*/
        watchDirectoryOfFailedLookupLocation(directory: string, cb: DirectoryWatcherCallback, flags: WatchDirectoryFlags) {
            return this.projectService.watchDirectory(
                this.projectService.host,
                directory,
                cb,
                flags,
                WatchType.FailedLookupLocation,
                this
            );
        }

        /*@internal*/
        onInvalidatedResolution() {
            this.projectService.delayUpdateProjectGraphAndInferredProjectsRefresh(this);
        }

        /*@internal*/
        watchTypeRootsDirectory(directory: string, cb: DirectoryWatcherCallback, flags: WatchDirectoryFlags) {
            return this.projectService.watchDirectory(
                this.projectService.host,
                directory,
                cb,
                flags,
                WatchType.TypeRoots,
                this
            );
        }

        /*@internal*/
        onChangedAutomaticTypeDirectiveNames() {
            this.hasChangedAutomaticTypeDirectiveNames = true;
            this.projectService.delayUpdateProjectGraphAndInferredProjectsRefresh(this);
        }

        /*@internal*/
        getGlobalCache() {
            return this.getTypeAcquisition().enable ? this.projectService.typingsInstaller.globalTypingsCacheLocation : undefined;
        }

        /*@internal*/
        writeLog(s: string) {
            this.projectService.logger.info(s);
        }

        private setInternalCompilerOptionsForEmittingJsFiles() {
            if (this.projectKind === ProjectKind.Inferred || this.projectKind === ProjectKind.External) {
                this.compilerOptions.noEmitForJsFiles = true;
            }
        }

        /**
         * Get the errors that dont have any file name associated
         */
        getGlobalProjectErrors(): ReadonlyArray<Diagnostic> {
            return emptyArray;
        }

        getAllProjectErrors(): ReadonlyArray<Diagnostic> {
            return emptyArray;
        }

        getLanguageService(ensureSynchronized = true): LanguageService {
            if (ensureSynchronized) {
                this.updateGraph();
            }
            return this.languageService;
        }

        private ensureBuilder() {
            if (!this.builder) {
                this.builder = createBuilder(
                    this.projectService.toCanonicalFileName,
                    (_program, sourceFile, emitOnlyDts, isDetailed) => this.getFileEmitOutput(sourceFile, emitOnlyDts, isDetailed),
                    data => this.projectService.host.createHash(data),
                    sourceFile => !this.projectService.getScriptInfoForPath(sourceFile.path).isDynamicOrHasMixedContent()
                );
            }
        }

        getCompileOnSaveAffectedFileList(scriptInfo: ScriptInfo): string[] {
            if (!this.languageServiceEnabled) {
                return [];
            }
            this.updateGraph();
            this.ensureBuilder();
            return this.builder.getFilesAffectedBy(this.program, scriptInfo.path);
        }

        /**
         * Returns true if emit was conducted
         */
        emitFile(scriptInfo: ScriptInfo, writeFile: (path: string, data: string, writeByteOrderMark?: boolean) => void): boolean {
            this.ensureBuilder();
            const { emitSkipped, outputFiles } = this.builder.emitFile(this.program, scriptInfo.path);
            if (!emitSkipped) {
                const projectRootPath = this.getProjectRootPath();
                for (const outputFile of outputFiles) {
                    const outputFileAbsoluteFileName = getNormalizedAbsolutePath(outputFile.name, projectRootPath ? projectRootPath : getDirectoryPath(scriptInfo.fileName));
                    writeFile(outputFileAbsoluteFileName, outputFile.text, outputFile.writeByteOrderMark);
                }
            }

            return !emitSkipped;
        }

        enableLanguageService() {
            if (this.languageServiceEnabled) {
                return;
            }
            this.languageServiceEnabled = true;
            this.projectService.onUpdateLanguageServiceStateForProject(this, /*languageServiceEnabled*/ true);
        }

        disableLanguageService() {
            if (!this.languageServiceEnabled) {
                return;
            }
            this.languageService.cleanupSemanticCache();
            this.languageServiceEnabled = false;
            this.resolutionCache.closeTypeRootsWatch();
            this.projectService.onUpdateLanguageServiceStateForProject(this, /*languageServiceEnabled*/ false);
        }

        getProjectName() {
            return this.projectName;
        }
        abstract getProjectRootPath(): string | undefined;
        abstract getTypeAcquisition(): TypeAcquisition;

        getExternalFiles(): SortedReadonlyArray<string> {
            return emptyArray as SortedReadonlyArray<string>;
        }

        getSourceFile(path: Path) {
            if (!this.program) {
                return undefined;
            }
            return this.program.getSourceFileByPath(path);
        }

        close() {
            if (this.program) {
                // if we have a program - release all files that are enlisted in program
                for (const f of this.program.getSourceFiles()) {
                    const info = this.projectService.getScriptInfo(f.fileName);
                    // We might not find the script info in case its not associated with the project any more
                    // and project graph was not updated (eg delayed update graph in case of files changed/deleted on the disk)
                    if (info) {
                        info.detachFromProject(this);
                    }
                }
            }
            if (!this.program || !this.languageServiceEnabled) {
                // release all root files either if there is no program or language service is disabled.
                // in the latter case set of root files can be larger than the set of files in program.
                for (const root of this.rootFiles) {
                    root.detachFromProject(this);
                }
            }
            this.rootFiles = undefined;
            this.rootFilesMap = undefined;
            this.program = undefined;
            this.builder = undefined;
            this.resolutionCache.clear();
            this.resolutionCache = undefined;
            this.cachedUnresolvedImportsPerFile = undefined;
            this.directoryStructureHost = undefined;

            // Clean up file watchers waiting for missing files
            if (this.missingFilesMap) {
                clearMap(this.missingFilesMap, closeFileWatcher);
                this.missingFilesMap = undefined;
            }

            // signal language service to release source files acquired from document registry
            this.languageService.dispose();
            this.languageService = undefined;
        }

        isClosed() {
            return this.rootFiles === undefined;
        }

        hasRoots() {
            return this.rootFiles && this.rootFiles.length > 0;
        }

        getRootFiles() {
            return this.rootFiles && this.rootFiles.map(info => info.fileName);
        }

        /*@internal*/
        getRootFilesMap() {
            return this.rootFilesMap;
        }

        getRootScriptInfos() {
            return this.rootFiles;
        }

        getScriptInfos() {
            if (!this.languageServiceEnabled) {
                // if language service is not enabled - return just root files
                return this.rootFiles;
            }
            return map(this.program.getSourceFiles(), sourceFile => {
                const scriptInfo = this.projectService.getScriptInfoForPath(sourceFile.path);
                if (!scriptInfo) {
                    Debug.fail(`scriptInfo for a file '${sourceFile.fileName}' is missing.`);
                }
                return scriptInfo;
            });
        }

        private getFileEmitOutput(sourceFile: SourceFile, emitOnlyDtsFiles: boolean, isDetailed: boolean) {
            if (!this.languageServiceEnabled) {
                return undefined;
            }
            return this.getLanguageService(/*ensureSynchronized*/ false).getEmitOutput(sourceFile.fileName, emitOnlyDtsFiles, isDetailed);
        }

        getExcludedFiles(): ReadonlyArray<NormalizedPath> {
            return emptyArray;
        }

        getFileNames(excludeFilesFromExternalLibraries?: boolean, excludeConfigFiles?: boolean) {
            if (!this.program) {
                return [];
            }

            if (!this.languageServiceEnabled) {
                // if language service is disabled assume that all files in program are root files + default library
                let rootFiles = this.getRootFiles();
                if (this.compilerOptions) {
                    const defaultLibrary = getDefaultLibFilePath(this.compilerOptions);
                    if (defaultLibrary) {
                        (rootFiles || (rootFiles = [])).push(asNormalizedPath(defaultLibrary));
                    }
                }
                return rootFiles;
            }
            const result: NormalizedPath[] = [];
            for (const f of this.program.getSourceFiles()) {
                if (excludeFilesFromExternalLibraries && this.program.isSourceFileFromExternalLibrary(f)) {
                    continue;
                }
                result.push(asNormalizedPath(f.fileName));
            }
            if (!excludeConfigFiles) {
                const configFile = this.program.getCompilerOptions().configFile;
                if (configFile) {
                    result.push(asNormalizedPath(configFile.fileName));
                    if (configFile.extendedSourceFiles) {
                        for (const f of configFile.extendedSourceFiles) {
                            result.push(asNormalizedPath(f));
                        }
                    }
                }
            }
            return result;
        }

        hasConfigFile(configFilePath: NormalizedPath) {
            if (this.program && this.languageServiceEnabled) {
                const configFile = this.program.getCompilerOptions().configFile;
                if (configFile) {
                    if (configFilePath === asNormalizedPath(configFile.fileName)) {
                        return true;
                    }
                    if (configFile.extendedSourceFiles) {
                        for (const f of configFile.extendedSourceFiles) {
                            if (configFilePath === asNormalizedPath(f)) {
                                return true;
                            }
                        }
                    }
                }
            }
            return false;
        }

        containsScriptInfo(info: ScriptInfo): boolean {
            return this.isRoot(info) || (this.program && this.program.getSourceFileByPath(info.path) !== undefined);
        }

        containsFile(filename: NormalizedPath, requireOpen?: boolean) {
            const info = this.projectService.getScriptInfoForNormalizedPath(filename);
            if (info && (info.isScriptOpen() || !requireOpen)) {
                return this.containsScriptInfo(info);
            }
        }

        isRoot(info: ScriptInfo) {
            return this.rootFilesMap && this.rootFilesMap.get(info.path) === info;
        }

        // add a root file to project
        addRoot(info: ScriptInfo) {
            Debug.assert(!this.isRoot(info));
            this.rootFiles.push(info);
            this.rootFilesMap.set(info.path, info);
            info.attachToProject(this);

            this.markAsDirty();
        }

        // add a root file that doesnt exist on host
        addMissingFileRoot(fileName: NormalizedPath) {
            const path = this.projectService.toPath(fileName);
            this.rootFilesMap.set(path, fileName);
            this.markAsDirty();
        }

        removeFile(info: ScriptInfo, fileExists: boolean, detachFromProject: boolean) {
            if (this.isRoot(info)) {
                this.removeRoot(info);
            }
            if (fileExists) {
                // If file is present, just remove the resolutions for the file
                this.resolutionCache.removeResolutionsOfFile(info.path);
            }
            else {
                this.resolutionCache.invalidateResolutionOfFile(info.path);
            }
            this.cachedUnresolvedImportsPerFile.remove(info.path);

            if (detachFromProject) {
                info.detachFromProject(this);
            }

            this.markAsDirty();
        }

        registerFileUpdate(fileName: string) {
            (this.updatedFileNames || (this.updatedFileNames = createMap<true>())).set(fileName, true);
        }

        markAsDirty() {
            this.projectStateVersion++;
        }

        private extractUnresolvedImportsFromSourceFile(file: SourceFile, result: Push<string>) {
            const cached = this.cachedUnresolvedImportsPerFile.get(file.path);
            if (cached) {
                // found cached result - use it and return
                for (const f of cached) {
                    result.push(f);
                }
                return;
            }
            let unresolvedImports: string[];
            if (file.resolvedModules) {
                file.resolvedModules.forEach((resolvedModule, name) => {
                    // pick unresolved non-relative names
                    if (!resolvedModule && !isExternalModuleNameRelative(name)) {
                        // for non-scoped names extract part up-to the first slash
                        // for scoped names - extract up to the second slash
                        let trimmed = name.trim();
                        let i = trimmed.indexOf("/");
                        if (i !== -1 && trimmed.charCodeAt(0) === CharacterCodes.at) {
                            i = trimmed.indexOf("/", i + 1);
                        }
                        if (i !== -1) {
                            trimmed = trimmed.substr(0, i);
                        }
                        (unresolvedImports || (unresolvedImports = [])).push(trimmed);
                        result.push(trimmed);
                    }
                });
            }
            this.cachedUnresolvedImportsPerFile.set(file.path, unresolvedImports || emptyArray);
        }

        /**
         * Updates set of files that contribute to this project
         * @returns: true if set of files in the project stays the same and false - otherwise.
         */
        updateGraph(): boolean {
            this.resolutionCache.startRecordingFilesWithChangedResolutions();
            this.hasInvalidatedResolution = this.resolutionCache.createHasInvalidatedResolution();

            let hasChanges = this.updateGraphWorker();

            const changedFiles: ReadonlyArray<Path> = this.resolutionCache.finishRecordingFilesWithChangedResolutions() || emptyArray;

            for (const file of changedFiles) {
                // delete cached information for changed files
                this.cachedUnresolvedImportsPerFile.remove(file);
            }

            // update builder only if language service is enabled
            // otherwise tell it to drop its internal state
            if (this.languageServiceEnabled) {
                // 1. no changes in structure, no changes in unresolved imports - do nothing
                // 2. no changes in structure, unresolved imports were changed - collect unresolved imports for all files
                // (can reuse cached imports for files that were not changed)
                // 3. new files were added/removed, but compilation settings stays the same - collect unresolved imports for all new/modified files
                // (can reuse cached imports for files that were not changed)
                // 4. compilation settings were changed in the way that might affect module resolution - drop all caches and collect all data from the scratch
                if (hasChanges || changedFiles.length) {
                    const result: string[] = [];
                    for (const sourceFile of this.program.getSourceFiles()) {
                        this.extractUnresolvedImportsFromSourceFile(sourceFile, result);
                    }
                    this.lastCachedUnresolvedImportsList = toDeduplicatedSortedArray(result);
                }

                const cachedTypings = this.projectService.typingsCache.getTypingsForProject(this, this.lastCachedUnresolvedImportsList, hasChanges);
                if (this.setTypings(cachedTypings)) {
                    hasChanges = this.updateGraphWorker() || hasChanges;
                }
                if (this.builder) {
                    this.builder.updateProgram(this.program);
                }
            }
            else {
                this.lastCachedUnresolvedImportsList = undefined;
                if (this.builder) {
                    this.builder.clear();
                }
            }

            if (hasChanges) {
                this.projectStructureVersion++;
            }
            return !hasChanges;
        }

        private setTypings(typings: SortedReadonlyArray<string>): boolean {
            if (arrayIsEqualTo(this.typingFiles, typings)) {
                return false;
            }
            this.typingFiles = typings;
            this.markAsDirty();
            return true;
        }

        private updateGraphWorker() {
            const oldProgram = this.program;

            this.writeLog(`Starting updateGraphWorker: Project: ${this.getProjectName()}`);
            const start = timestamp();
            this.resolutionCache.startCachingPerDirectoryResolution();
            this.program = this.languageService.getProgram();
            this.resolutionCache.finishCachingPerDirectoryResolution();

            // bump up the version if
            // - oldProgram is not set - this is a first time updateGraph is called
            // - newProgram is different from the old program and structure of the old program was not reused.
            const hasChanges = !oldProgram || (this.program !== oldProgram && !(oldProgram.structureIsReused & StructureIsReused.Completely));
            this.hasChangedAutomaticTypeDirectiveNames = false;
            if (hasChanges) {
                if (oldProgram) {
                    for (const f of oldProgram.getSourceFiles()) {
                        if (this.program.getSourceFileByPath(f.path)) {
                            continue;
                        }
                        // new program does not contain this file - detach it from the project
                        this.detachScriptInfoFromProject(f.fileName);
                    }
                }

                // Update the missing file paths watcher
                updateMissingFilePathsWatch(
                    this.program,
                    this.missingFilesMap || (this.missingFilesMap = createMap()),
                    // Watch the missing files
                    missingFilePath => this.addMissingFileWatcher(missingFilePath)
                );

                // Watch the type locations that would be added to program as part of automatic type resolutions
                if (this.languageServiceEnabled) {
                    this.resolutionCache.updateTypeRootsWatch();
                }
            }

            const oldExternalFiles = this.externalFiles || emptyArray as SortedReadonlyArray<string>;
            this.externalFiles = this.getExternalFiles();
            enumerateInsertsAndDeletes(this.externalFiles, oldExternalFiles,
                // Ensure a ScriptInfo is created for new external files. This is performed indirectly
                // by the LSHost for files in the program when the program is retrieved above but
                // the program doesn't contain external files so this must be done explicitly.
                inserted => {
                    const scriptInfo = this.projectService.getOrCreateScriptInfoNotOpenedByClient(inserted, this.directoryStructureHost);
                    scriptInfo.attachToProject(this);
                },
                removed => this.detachScriptInfoFromProject(removed)
            );
            const elapsed = timestamp() - start;
            this.writeLog(`Finishing updateGraphWorker: Project: ${this.getProjectName()} structureChanged: ${hasChanges} Elapsed: ${elapsed}ms`);
            return hasChanges;
        }

        private detachScriptInfoFromProject(uncheckedFileName: string) {
            const scriptInfoToDetach = this.projectService.getScriptInfo(uncheckedFileName);
            if (scriptInfoToDetach) {
                scriptInfoToDetach.detachFromProject(this);
                this.resolutionCache.removeResolutionsOfFile(scriptInfoToDetach.path);
            }
        }

        private addMissingFileWatcher(missingFilePath: Path) {
            const fileWatcher = this.projectService.watchFile(
                this.projectService.host,
                missingFilePath,
                (fileName, eventKind) => {
                    if (this.projectKind === ProjectKind.Configured) {
                        (this.directoryStructureHost as CachedDirectoryStructureHost).addOrDeleteFile(fileName, missingFilePath, eventKind);
                    }

                    if (eventKind === FileWatcherEventKind.Created && this.missingFilesMap.has(missingFilePath)) {
                        this.missingFilesMap.delete(missingFilePath);
                        fileWatcher.close();

                        // When a missing file is created, we should update the graph.
                        this.projectService.delayUpdateProjectGraphAndInferredProjectsRefresh(this);
                    }
                },
                WatchType.MissingFilePath,
                this
            );
            return fileWatcher;
        }

        private isWatchedMissingFile(path: Path) {
            return this.missingFilesMap && this.missingFilesMap.has(path);
        }

        getScriptInfoForNormalizedPath(fileName: NormalizedPath) {
            const scriptInfo = this.projectService.getOrCreateScriptInfoNotOpenedByClientForNormalizedPath(
                fileName, /*scriptKind*/ undefined, /*hasMixedContent*/ undefined, this.directoryStructureHost
            );
            if (scriptInfo && !scriptInfo.isAttached(this)) {
                return Errors.ThrowProjectDoesNotContainDocument(fileName, this);
            }
            return scriptInfo;
        }

        getScriptInfo(uncheckedFileName: string) {
            return this.getScriptInfoForNormalizedPath(toNormalizedPath(uncheckedFileName));
        }

        filesToString(writeProjectFileNames: boolean) {
            if (!this.program) {
                return "\tFiles (0)\n";
            }
            const sourceFiles = this.program.getSourceFiles();
            let strBuilder = `\tFiles (${sourceFiles.length})\n`;
            if (writeProjectFileNames) {
                for (const file of sourceFiles) {
                    strBuilder += `\t${file.fileName}\n`;
                }
            }
            return strBuilder;
        }

        setCompilerOptions(compilerOptions: CompilerOptions) {
            if (compilerOptions) {
                compilerOptions.allowNonTsExtensions = true;
                if (changesAffectModuleResolution(this.compilerOptions, compilerOptions)) {
                    // reset cached unresolved imports if changes in compiler options affected module resolution
                    this.cachedUnresolvedImportsPerFile.clear();
                    this.lastCachedUnresolvedImportsList = undefined;
                }
                const oldOptions = this.compilerOptions;
                this.compilerOptions = compilerOptions;
                this.setInternalCompilerOptionsForEmittingJsFiles();
                if (changesAffectModuleResolution(oldOptions, compilerOptions)) {
                    this.resolutionCache.clear();
                }
                this.markAsDirty();
            }
        }

        reloadScript(filename: NormalizedPath, tempFileName?: NormalizedPath): boolean {
            const script = this.projectService.getScriptInfoForNormalizedPath(filename);
            if (script) {
                Debug.assert(script.isAttached(this));
                script.reloadFromFile(tempFileName);
                return true;
            }
            return false;
        }

        /* @internal */
        getChangesSinceVersion(lastKnownVersion?: number): ProjectFilesWithTSDiagnostics {
            this.updateGraph();

            const info = {
                projectName: this.getProjectName(),
                version: this.projectStructureVersion,
                isInferred: this.projectKind === ProjectKind.Inferred,
                options: this.getCompilationSettings(),
                languageServiceDisabled: !this.languageServiceEnabled
            };
            const updatedFileNames = this.updatedFileNames;
            this.updatedFileNames = undefined;
            // check if requested version is the same that we have reported last time
            if (this.lastReportedFileNames && lastKnownVersion === this.lastReportedVersion) {
                // if current structure version is the same - return info without any changes
                if (this.projectStructureVersion === this.lastReportedVersion && !updatedFileNames) {
                    return { info, projectErrors: this.getGlobalProjectErrors() };
                }
                // compute and return the difference
                const lastReportedFileNames = this.lastReportedFileNames;
                const externalFiles = this.getExternalFiles().map(f => toNormalizedPath(f));
                const currentFiles = arrayToSet(this.getFileNames().concat(externalFiles));

                const added: string[] = [];
                const removed: string[] = [];
                const updated: string[] = updatedFileNames ? arrayFrom(updatedFileNames.keys()) : [];

                forEachKey(currentFiles, id => {
                    if (!lastReportedFileNames.has(id)) {
                        added.push(id);
                    }
                });
                forEachKey(lastReportedFileNames, id => {
                    if (!currentFiles.has(id)) {
                        removed.push(id);
                    }
                });
                this.lastReportedFileNames = currentFiles;
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, changes: { added, removed, updated }, projectErrors: this.getGlobalProjectErrors() };
            }
            else {
                // unknown version - return everything
                const projectFileNames = this.getFileNames();
                const externalFiles = this.getExternalFiles().map(f => toNormalizedPath(f));
                const allFiles = projectFileNames.concat(externalFiles);
                this.lastReportedFileNames = arrayToSet(allFiles);
                this.lastReportedVersion = this.projectStructureVersion;
                return { info, files: allFiles, projectErrors: this.getGlobalProjectErrors() };
            }
        }

        // remove a root file from project
        protected removeRoot(info: ScriptInfo): void {
            orderedRemoveItem(this.rootFiles, info);
            this.rootFilesMap.delete(info.path);
        }
    }

    /**
     * If a file is opened and no tsconfig (or jsconfig) is found,
     * the file and its imports/references are put into an InferredProject.
     */
    export class InferredProject extends Project {
        private static readonly newName = (() => {
            let nextId = 1;
            return () => {
                const id = nextId;
                nextId++;
                return makeInferredProjectName(id);
            };
        })();

        private _isJsInferredProject = false;

        toggleJsInferredProject(isJsInferredProject: boolean) {
            if (isJsInferredProject !== this._isJsInferredProject) {
                this._isJsInferredProject = isJsInferredProject;
                this.setCompilerOptions();
            }
        }

        setCompilerOptions(options?: CompilerOptions) {
            // Avoid manipulating the given options directly
            const newOptions = options ? cloneCompilerOptions(options) : this.getCompilationSettings();
            if (!newOptions) {
                return;
            }

            if (this._isJsInferredProject && typeof newOptions.maxNodeModuleJsDepth !== "number") {
                newOptions.maxNodeModuleJsDepth = 2;
            }
            else if (!this._isJsInferredProject) {
                newOptions.maxNodeModuleJsDepth = undefined;
            }
            newOptions.allowJs = true;
            super.setCompilerOptions(newOptions);
        }

        /*@internal*/
        constructor(
            projectService: ProjectService,
            documentRegistry: DocumentRegistry,
            compilerOptions: CompilerOptions,
            public readonly projectRootPath: string | undefined,
            rootDirectoryForResolution: string | undefined) {
            super(InferredProject.newName(),
                ProjectKind.Inferred,
                projectService,
                documentRegistry,
                /*files*/ undefined,
                /*languageServiceEnabled*/ true,
                compilerOptions,
                /*compileOnSaveEnabled*/ false,
                projectService.host,
                rootDirectoryForResolution);
        }

        addRoot(info: ScriptInfo) {
            this.projectService.startWatchingConfigFilesForInferredProjectRoot(info);
            if (!this._isJsInferredProject && info.isJavaScript()) {
                this.toggleJsInferredProject(/*isJsInferredProject*/ true);
            }
            super.addRoot(info);
        }

        removeRoot(info: ScriptInfo) {
            this.projectService.stopWatchingConfigFilesForInferredProjectRoot(info);
            super.removeRoot(info);
            if (this._isJsInferredProject && info.isJavaScript()) {
                if (every(this.getRootScriptInfos(), rootInfo => !rootInfo.isJavaScript())) {
                    this.toggleJsInferredProject(/*isJsInferredProject*/ false);
                }
            }
        }

        isProjectWithSingleRoot() {
            // - when useSingleInferredProject is not set and projectRootPath is not set,
            //   we can guarantee that this will be the only root
            // - other wise it has single root if it has single root script info
            return (!this.projectRootPath && !this.projectService.useSingleInferredProject) ||
                this.getRootScriptInfos().length === 1;
        }

        getProjectRootPath() {
            return this.projectRootPath ||
                // Single inferred project does not have a project root.
                !this.projectService.useSingleInferredProject && getDirectoryPath(this.getRootFiles()[0]);
        }

        close() {
            forEach(this.getRootScriptInfos(), info => this.projectService.stopWatchingConfigFilesForInferredProjectRoot(info));
            super.close();
        }

        getTypeAcquisition(): TypeAcquisition {
            return {
                enable: allRootFilesAreJsOrDts(this),
                include: [],
                exclude: []
            };
        }
    }

    /**
     * If a file is opened, the server will look for a tsconfig (or jsconfig)
     * and if successfull create a ConfiguredProject for it.
     * Otherwise it will create an InferredProject.
     */
    export class ConfiguredProject extends Project {
        private typeAcquisition: TypeAcquisition;
        /* @internal */
        configFileWatcher: FileWatcher;
        private directoriesWatchedForWildcards: Map<WildcardDirectoryWatcher> | undefined;
        readonly canonicalConfigFilePath: NormalizedPath;

        /* @internal */
        pendingReload: boolean;

        /*@internal*/
        configFileSpecs: ConfigFileSpecs;

        private plugins: PluginModule[] = [];

        /** Used for configured projects which may have multiple open roots */
        openRefCount = 0;

        private projectErrors: Diagnostic[];

        /*@internal*/
        constructor(configFileName: NormalizedPath,
            projectService: ProjectService,
            documentRegistry: DocumentRegistry,
            hasExplicitListOfFiles: boolean,
            compilerOptions: CompilerOptions,
            languageServiceEnabled: boolean,
            public compileOnSaveEnabled: boolean,
            cachedDirectoryStructureHost: CachedDirectoryStructureHost) {
            super(configFileName,
                ProjectKind.Configured,
                projectService,
                documentRegistry,
                hasExplicitListOfFiles,
                languageServiceEnabled,
                compilerOptions,
                compileOnSaveEnabled,
                cachedDirectoryStructureHost,
                getDirectoryPath(configFileName));
            this.canonicalConfigFilePath = asNormalizedPath(projectService.toCanonicalFileName(configFileName));
            this.enablePlugins();
        }

        /**
         * If the project has reload from disk pending, it reloads (and then updates graph as part of that) instead of just updating the graph
         * @returns: true if set of files in the project stays the same and false - otherwise.
         */
        updateGraph(): boolean {
            if (this.pendingReload) {
                this.pendingReload = false;
                this.projectService.reloadConfiguredProject(this);
                return true;
            }
            return super.updateGraph();
        }

        /*@internal*/
        getCachedDirectoryStructureHost() {
            return this.directoryStructureHost as CachedDirectoryStructureHost;
        }

        getConfigFilePath() {
            return asNormalizedPath(this.getProjectName());
        }

        enablePlugins() {
            const host = this.projectService.host;
            const options = this.getCompilationSettings();

            if (!host.require) {
                this.projectService.logger.info("Plugins were requested but not running in environment that supports 'require'. Nothing will be loaded");
                return;
            }

            // Search our peer node_modules, then any globally-specified probe paths
            // ../../.. to walk from X/node_modules/typescript/lib/tsserver.js to X/node_modules/
            const searchPaths = [combinePaths(host.getExecutingFilePath(), "../../.."), ...this.projectService.pluginProbeLocations];

            if (this.projectService.allowLocalPluginLoads) {
                const local = getDirectoryPath(this.canonicalConfigFilePath);
                this.projectService.logger.info(`Local plugin loading enabled; adding ${local} to search paths`);
                searchPaths.unshift(local);
            }

            // Enable tsconfig-specified plugins
            if (options.plugins) {
                for (const pluginConfigEntry of options.plugins) {
                    this.enablePlugin(pluginConfigEntry, searchPaths);
                }
            }

            if (this.projectService.globalPlugins) {
                // Enable global plugins with synthetic configuration entries
                for (const globalPluginName of this.projectService.globalPlugins) {
                    // Skip empty names from odd commandline parses
                    if (!globalPluginName) continue;

                    // Skip already-locally-loaded plugins
                    if (options.plugins && options.plugins.some(p => p.name === globalPluginName)) continue;

                    // Provide global: true so plugins can detect why they can't find their config
                    this.projectService.logger.info(`Loading global plugin ${globalPluginName}`);
                    this.enablePlugin({ name: globalPluginName, global: true } as PluginImport, searchPaths);
                }
            }
        }

        private enablePlugin(pluginConfigEntry: PluginImport, searchPaths: string[]) {
            this.projectService.logger.info(`Enabling plugin ${pluginConfigEntry.name} from candidate paths: ${searchPaths.join(",")}`);

            const log = (message: string) => {
                this.projectService.logger.info(message);
            };

            for (const searchPath of searchPaths) {
                const resolvedModule = <PluginModuleFactory>Project.resolveModule(pluginConfigEntry.name, searchPath, this.projectService.host, log);
                if (resolvedModule) {
                    this.enableProxy(resolvedModule, pluginConfigEntry);
                    return;
                }
            }
            this.projectService.logger.info(`Couldn't find ${pluginConfigEntry.name}`);
        }

        private enableProxy(pluginModuleFactory: PluginModuleFactory, configEntry: PluginImport) {
            try {
                if (typeof pluginModuleFactory !== "function") {
                    this.projectService.logger.info(`Skipped loading plugin ${configEntry.name} because it did expose a proper factory function`);
                    return;
                }

                const info: PluginCreateInfo = {
                    config: configEntry,
                    project: this,
                    languageService: this.languageService,
                    languageServiceHost: this,
                    serverHost: this.projectService.host
                };

                const pluginModule = pluginModuleFactory({ typescript: ts });
                const newLS = pluginModule.create(info);
                for (const k of Object.keys(this.languageService)) {
                    if (!(k in newLS)) {
                        this.projectService.logger.info(`Plugin activation warning: Missing proxied method ${k} in created LS. Patching.`);
                        (newLS as any)[k] = (this.languageService as any)[k];
                    }
                }
                this.projectService.logger.info(`Plugin validation succeded`);
                this.languageService = newLS;
                this.plugins.push(pluginModule);
            }
            catch (e) {
                this.projectService.logger.info(`Plugin activation failed: ${e}`);
            }
        }

        getProjectRootPath() {
            return getDirectoryPath(this.getConfigFilePath());
        }

        /**
         * Get the errors that dont have any file name associated
         */
        getGlobalProjectErrors(): ReadonlyArray<Diagnostic> {
            return filter(this.projectErrors, diagnostic => !diagnostic.file);
        }

        /**
         * Get all the project errors
         */
        getAllProjectErrors(): ReadonlyArray<Diagnostic> {
            return this.projectErrors;
        }

        setProjectErrors(projectErrors: Diagnostic[]) {
            this.projectErrors = projectErrors;
        }

        setTypeAcquisition(newTypeAcquisition: TypeAcquisition): void {
            this.typeAcquisition = newTypeAcquisition;
        }

        getTypeAcquisition() {
            return this.typeAcquisition;
        }

        getExternalFiles(): SortedReadonlyArray<string> {
            return toSortedArray(flatMap(this.plugins, plugin => {
                if (typeof plugin.getExternalFiles !== "function") return;
                try {
                    return plugin.getExternalFiles(this);
                }
                catch (e) {
                    this.projectService.logger.info(`A plugin threw an exception in getExternalFiles: ${e}`);
                    if (e.stack) {
                        this.projectService.logger.info(e.stack);
                    }
                }
            }));
        }

        /*@internal*/
        watchWildcards(wildcardDirectories: Map<WatchDirectoryFlags>) {
            updateWatchingWildcardDirectories(
                this.directoriesWatchedForWildcards || (this.directoriesWatchedForWildcards = createMap()),
                wildcardDirectories,
                // Create new directory watcher
                (directory, flags) => this.projectService.watchWildcardDirectory(directory as Path, flags, this),
            );
        }

        /*@internal*/
        stopWatchingWildCards() {
            if (this.directoriesWatchedForWildcards) {
                clearMap(this.directoriesWatchedForWildcards, closeFileWatcherOf);
                this.directoriesWatchedForWildcards = undefined;
            }
        }

        close() {
            super.close();

            if (this.configFileWatcher) {
                this.configFileWatcher.close();
                this.configFileWatcher = undefined;
            }

            this.stopWatchingWildCards();
        }

        addOpenRef() {
            this.openRefCount++;
        }

        deleteOpenRef() {
            this.openRefCount--;
            return this.openRefCount;
        }

        hasOpenRef() {
            return !!this.openRefCount;
        }

        getEffectiveTypeRoots() {
            return getEffectiveTypeRoots(this.getCompilationSettings(), this.directoryStructureHost) || [];
        }

        /*@internal*/
        updateErrorOnNoInputFiles(hasFileNames: boolean) {
            if (hasFileNames) {
                filterMutate(this.projectErrors, error => !isErrorNoInputFiles(error));
            }
            else if (!this.configFileSpecs.filesSpecs && !some(this.projectErrors, isErrorNoInputFiles)) {
                this.projectErrors.push(getErrorForNoInputFiles(this.configFileSpecs, this.getConfigFilePath()));
            }
        }
    }

    /**
     * Project whose configuration is handled externally, such as in a '.csproj'.
     * These are created only if a host explicitly calls `openExternalProject`.
     */
    export class ExternalProject extends Project {
        excludedFiles: ReadonlyArray<NormalizedPath> = [];
        private typeAcquisition: TypeAcquisition;
        /*@internal*/
        constructor(public externalProjectName: string,
            projectService: ProjectService,
            documentRegistry: DocumentRegistry,
            compilerOptions: CompilerOptions,
            languageServiceEnabled: boolean,
            public compileOnSaveEnabled: boolean,
            private readonly projectFilePath?: string) {
            super(externalProjectName,
                ProjectKind.External,
                projectService,
                documentRegistry,
                /*hasExplicitListOfFiles*/ true,
                languageServiceEnabled, compilerOptions,
                compileOnSaveEnabled,
                projectService.host,
                getDirectoryPath(projectFilePath || normalizeSlashes(externalProjectName)));
        }

        getExcludedFiles() {
            return this.excludedFiles;
        }

        getProjectRootPath() {
            if (this.projectFilePath) {
                return getDirectoryPath(this.projectFilePath);
            }
            // if the projectFilePath is not given, we make the assumption that the project name
            // is the path of the project file. AS the project name is provided by VS, we need to
            // normalize slashes before using it as a file name.
            return getDirectoryPath(normalizeSlashes(this.getProjectName()));
        }

        getTypeAcquisition() {
            return this.typeAcquisition;
        }

        setTypeAcquisition(newTypeAcquisition: TypeAcquisition): void {
            if (!newTypeAcquisition) {
                // set default typings options
                newTypeAcquisition = {
                    enable: allRootFilesAreJsOrDts(this),
                    include: [],
                    exclude: []
                };
            }
            else {
                if (newTypeAcquisition.enable === undefined) {
                    // if autoDiscovery was not specified by the caller - set it based on the content of the project
                    newTypeAcquisition.enable = allRootFilesAreJsOrDts(this);
                }
                if (!newTypeAcquisition.include) {
                    newTypeAcquisition.include = [];
                }
                if (!newTypeAcquisition.exclude) {
                    newTypeAcquisition.exclude = [];
                }
            }
            this.typeAcquisition = newTypeAcquisition;
        }
    }
}
