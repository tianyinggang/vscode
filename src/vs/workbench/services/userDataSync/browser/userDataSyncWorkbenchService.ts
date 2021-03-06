/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IUserDataSyncService, IAuthenticationProvider, getUserDataSyncStore, isAuthenticationProvider, IUserDataAutoSyncService, SyncResource, IResourcePreview, ISyncResourcePreview, Change, IManualSyncTask } from 'vs/platform/userDataSync/common/userDataSync';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IUserDataSyncWorkbenchService, IUserDataSyncAccount, AccountStatus, CONTEXT_SYNC_ENABLEMENT, CONTEXT_SYNC_STATE, CONTEXT_ACCOUNT_STATE, SHOW_SYNC_LOG_COMMAND_ID, getSyncAreaLabel, IUserDataSyncPreview, IUserDataSyncResourceGroup, CONTEXT_SHOW_MANUAL_SYNC_VIEW, SHOW_SYNCED_DATA_COMMAND_ID, MANUAL_SYNC_VIEW_ID } from 'vs/workbench/services/userDataSync/common/userDataSync';
import { AuthenticationSession, AuthenticationSessionsChangeEvent } from 'vs/editor/common/modes';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { flatten, equals } from 'vs/base/common/arrays';
import { IAuthenticationService } from 'vs/workbench/services/authentication/browser/authenticationService';
import { IUserDataSyncAccountService } from 'vs/platform/userDataSync/common/userDataSyncAccount';
import { IQuickInputService, IQuickPickSeparator } from 'vs/platform/quickinput/common/quickInput';
import { IStorageService, IWorkspaceStorageChangeEvent, StorageScope } from 'vs/platform/storage/common/storage';
import { ILogService } from 'vs/platform/log/common/log';
import { IProductService } from 'vs/platform/product/common/productService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { localize } from 'vs/nls';
import { canceled } from 'vs/base/common/errors';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { Action } from 'vs/base/common/actions';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { isEqual } from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { IViewsService, ViewContainerLocation, IViewDescriptorService } from 'vs/workbench/common/views';
import { IDecorationsProvider, IDecorationData, IDecorationsService } from 'vs/workbench/services/decorations/browser/decorations';

type UserAccountClassification = {
	id: { classification: 'EndUserPseudonymizedInformation', purpose: 'BusinessInsight' };
};

type FirstTimeSyncClassification = {
	action: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

type UserAccountEvent = {
	id: string;
};

type FirstTimeSyncAction = 'pull' | 'push' | 'merge' | 'manual';

type AccountQuickPickItem = { label: string, authenticationProvider: IAuthenticationProvider, account?: UserDataSyncAccount, description?: string };

class UserDataSyncAccount implements IUserDataSyncAccount {

	constructor(readonly authenticationProviderId: string, private readonly session: AuthenticationSession) { }

	get sessionId(): string { return this.session.id; }
	get accountName(): string { return this.session.account.label; }
	get accountId(): string { return this.session.account.id; }
	get token(): string { return this.session.accessToken; }
}

export class UserDataSyncWorkbenchService extends Disposable implements IUserDataSyncWorkbenchService {

	_serviceBrand: any;

	private static DONOT_USE_WORKBENCH_SESSION_STORAGE_KEY = 'userDataSyncAccount.donotUseWorkbenchSession';
	private static CACHED_SESSION_STORAGE_KEY = 'userDataSyncAccountPreference';

	readonly authenticationProviders: IAuthenticationProvider[];

	private _accountStatus: AccountStatus = AccountStatus.Uninitialized;
	get accountStatus(): AccountStatus { return this._accountStatus; }
	private readonly _onDidChangeAccountStatus = this._register(new Emitter<AccountStatus>());
	readonly onDidChangeAccountStatus = this._onDidChangeAccountStatus.event;

	private _all: Map<string, UserDataSyncAccount[]> = new Map<string, UserDataSyncAccount[]>();
	get all(): UserDataSyncAccount[] { return flatten([...this._all.values()]); }

	get current(): UserDataSyncAccount | undefined { return this.all.filter(account => this.isCurrentAccount(account))[0]; }

	private readonly syncEnablementContext: IContextKey<boolean>;
	private readonly syncStatusContext: IContextKey<string>;
	private readonly accountStatusContext: IContextKey<string>;
	private readonly showManualSyncViewContext: IContextKey<boolean>;

	readonly userDataSyncPreview: UserDataSyncPreview = this._register(new UserDataSyncPreview(this.userDataSyncService));

	constructor(
		@IUserDataSyncService private readonly userDataSyncService: IUserDataSyncService,
		@IAuthenticationService private readonly authenticationService: IAuthenticationService,
		@IUserDataSyncAccountService private readonly userDataSyncAccountService: IUserDataSyncAccountService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@IUserDataAutoSyncService private readonly userDataAutoSyncService: IUserDataAutoSyncService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@IProductService productService: IProductService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExtensionService extensionService: IExtensionService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewsService private readonly viewsService: IViewsService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IDecorationsService decorationsService: IDecorationsService,
	) {
		super();
		this.authenticationProviders = getUserDataSyncStore(productService, configurationService)?.authenticationProviders || [];
		this.syncEnablementContext = CONTEXT_SYNC_ENABLEMENT.bindTo(contextKeyService);
		this.syncStatusContext = CONTEXT_SYNC_STATE.bindTo(contextKeyService);
		this.accountStatusContext = CONTEXT_ACCOUNT_STATE.bindTo(contextKeyService);
		this.showManualSyncViewContext = CONTEXT_SHOW_MANUAL_SYNC_VIEW.bindTo(contextKeyService);

		decorationsService.registerDecorationsProvider(this.userDataSyncPreview);

		if (this.authenticationProviders.length) {

			this.syncStatusContext.set(this.userDataSyncService.status);
			this._register(userDataSyncService.onDidChangeStatus(status => this.syncStatusContext.set(status)));
			this.syncEnablementContext.set(userDataAutoSyncService.isEnabled());
			this._register(userDataAutoSyncService.onDidChangeEnablement(enabled => this.syncEnablementContext.set(enabled)));

			extensionService.whenInstalledExtensionsRegistered().then(() => {
				if (this.authenticationProviders.every(({ id }) => authenticationService.isAuthenticationProviderRegistered(id))) {
					this.initialize();
				} else {
					const disposable = this.authenticationService.onDidRegisterAuthenticationProvider(() => {
						if (this.authenticationProviders.every(({ id }) => authenticationService.isAuthenticationProviderRegistered(id))) {
							disposable.dispose();
							this.initialize();
						}
					});
				}
			});
		}
	}

	private async initialize(): Promise<void> {
		if (this.currentSessionId === undefined && this.useWorkbenchSessionId && this.environmentService.options?.authenticationSessionId) {
			this.currentSessionId = this.environmentService.options.authenticationSessionId;
			this.useWorkbenchSessionId = false;
		}

		await this.update();

		this._register(
			Event.any(
				Event.filter(
					Event.any(
						this.authenticationService.onDidRegisterAuthenticationProvider,
						this.authenticationService.onDidUnregisterAuthenticationProvider,
					), info => this.isSupportedAuthenticationProviderId(info.id)),
				Event.filter(this.userDataSyncAccountService.onTokenFailed, isSuccessive => !isSuccessive))
				(() => this.update()));

		this._register(Event.filter(this.authenticationService.onDidChangeSessions, e => this.isSupportedAuthenticationProviderId(e.providerId))(({ event }) => this.onDidChangeSessions(event)));
		this._register(this.storageService.onDidChangeStorage(e => this.onDidChangeStorage(e)));
		this._register(Event.filter(this.userDataSyncAccountService.onTokenFailed, isSuccessive => isSuccessive)(() => this.onDidSuccessiveAuthFailures()));
	}

	private async update(): Promise<void> {
		const allAccounts: Map<string, UserDataSyncAccount[]> = new Map<string, UserDataSyncAccount[]>();
		for (const { id } of this.authenticationProviders) {
			const accounts = await this.getAccounts(id);
			allAccounts.set(id, accounts);
		}

		this._all = allAccounts;
		const current = this.current;
		await this.updateToken(current);
		this.updateAccountStatus(current);
	}

	private async getAccounts(authenticationProviderId: string): Promise<UserDataSyncAccount[]> {
		let accounts: Map<string, UserDataSyncAccount> = new Map<string, UserDataSyncAccount>();
		let currentAccount: UserDataSyncAccount | null = null;

		const sessions = await this.authenticationService.getSessions(authenticationProviderId) || [];
		for (const session of sessions) {
			const account: UserDataSyncAccount = new UserDataSyncAccount(authenticationProviderId, session);
			accounts.set(account.accountName, account);
			if (this.isCurrentAccount(account)) {
				currentAccount = account;
			}
		}

		if (currentAccount) {
			// Always use current account if available
			accounts.set(currentAccount.accountName, currentAccount);
		}

		return [...accounts.values()];
	}

	private async updateToken(current: UserDataSyncAccount | undefined): Promise<void> {
		let value: { token: string, authenticationProviderId: string } | undefined = undefined;
		if (current) {
			try {
				this.logService.trace('Preferences Sync: Updating the token for the account', current.accountName);
				const token = current.token;
				this.logService.trace('Preferences Sync: Token updated for the account', current.accountName);
				value = { token, authenticationProviderId: current.authenticationProviderId };
			} catch (e) {
				this.logService.error(e);
			}
		}
		await this.userDataSyncAccountService.updateAccount(value);
	}

	private updateAccountStatus(current: UserDataSyncAccount | undefined): void {
		// set status
		const accountStatus: AccountStatus = current ? AccountStatus.Available : AccountStatus.Unavailable;

		if (this._accountStatus !== accountStatus) {
			const previous = this._accountStatus;
			this.logService.debug('Sync account status changed', previous, accountStatus);

			this._accountStatus = accountStatus;
			this.accountStatusContext.set(accountStatus);
			this._onDidChangeAccountStatus.fire(accountStatus);
		}
	}

	async turnOn(): Promise<void> {
		const picked = await this.pick();
		if (!picked) {
			throw canceled();
		}

		// User did not pick an account or login failed
		if (this.accountStatus !== AccountStatus.Available) {
			throw new Error(localize('no account', "No account available"));
		}

		const preferencesSyncTitle = localize('preferences sync', "Preferences Sync");
		const title = `${preferencesSyncTitle} [(${localize('details', "details")})](command:${SHOW_SYNC_LOG_COMMAND_ID})`;
		await this.syncBeforeTurningOn(title);
		await this.userDataAutoSyncService.turnOn();
		this.notificationService.info(localize('sync turned on', "{0} is turned on", title));
	}

	turnoff(everywhere: boolean): Promise<void> {
		return this.userDataAutoSyncService.turnOff(everywhere);
	}

	private async syncBeforeTurningOn(title: string): Promise<void> {

		/* Make sure sync started on clean local state */
		await this.userDataSyncService.resetLocal();

		const manualSyncTask = await this.userDataSyncService.createManualSyncTask();
		try {
			let action: FirstTimeSyncAction = 'manual';
			let preview: [SyncResource, ISyncResourcePreview][] = [];

			await this.progressService.withProgress({
				location: ProgressLocation.Notification,
				title,
				delay: 500,
			}, async progress => {
				progress.report({ message: localize('turning on', "Turning on...") });

				preview = await manualSyncTask.preview();
				const hasRemoteData = manualSyncTask.manifest !== null;
				const hasLocalData = await this.userDataSyncService.hasLocalData();
				const hasChanges = preview.some(([, { resourcePreviews }]) => resourcePreviews.some(r => r.localChange !== Change.None || r.remoteChange !== Change.None));
				const isLastSyncFromCurrentMachine = preview.every(([, { isLastSyncFromCurrentMachine }]) => isLastSyncFromCurrentMachine);

				action = await this.getFirstTimeSyncAction(hasRemoteData, hasLocalData, hasChanges, isLastSyncFromCurrentMachine);
				const progressDisposable = manualSyncTask.onSynchronizeResources(synchronizingResources =>
					synchronizingResources.length ? progress.report({ message: localize('syncing resource', "Syncing {0}...", getSyncAreaLabel(synchronizingResources[0][0])) }) : undefined);
				try {
					switch (action) {
						case 'merge': return await manualSyncTask.merge();
						case 'pull': return await manualSyncTask.pull();
						case 'push': return await manualSyncTask.push();
						case 'manual': return;
					}
				} finally {
					progressDisposable.dispose();
				}
			});
			if (action === 'manual') {
				await this.syncManually(manualSyncTask, preview);
			}
		} catch (error) {
			await manualSyncTask.stop();
			throw error;
		} finally {
			manualSyncTask.dispose();
		}
	}

	private async getFirstTimeSyncAction(hasRemoteData: boolean, hasLocalData: boolean, hasChanges: boolean, isLastSyncFromCurrentMachine: boolean): Promise<FirstTimeSyncAction> {

		if (!hasLocalData /* no data on local */
			|| !hasRemoteData /* no data on remote */
			|| !hasChanges /* no changes  */
			|| isLastSyncFromCurrentMachine /* has changes but last sync is from current machine */
		) {
			return 'merge';
		}

		const result = await this.dialogService.show(
			Severity.Info,
			localize('Replace or Merge', "Replace or Merge"),
			[
				localize('sync manually', "Sync Manually"),
				localize('merge', "Merge"),
				localize('replace local', "Replace Local"),
				localize('cancel', "Cancel"),
			],
			{
				cancelId: 3,
				detail: localize('first time sync detail', "It looks like you last synced from another machine.\nWould you like to replace or merge with the synced data?"),
			}
		);
		switch (result.choice) {
			case 0:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'manual' });
				return 'manual';
			case 1:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'merge' });
				return 'merge';
			case 2:
				this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'pull' });
				return 'pull';
		}
		this.telemetryService.publicLog2<{ action: string }, FirstTimeSyncClassification>('sync/firstTimeSync', { action: 'cancelled' });
		throw canceled();
	}

	private async syncManually(task: IManualSyncTask, preview: [SyncResource, ISyncResourcePreview][]): Promise<void> {
		const visibleViewContainer = this.viewsService.getVisibleViewContainer(ViewContainerLocation.Sidebar);
		this.userDataSyncPreview.setManualSyncPreview(task, preview);

		this.showManualSyncViewContext.set(true);
		await this.commandService.executeCommand(SHOW_SYNCED_DATA_COMMAND_ID);
		await this.viewsService.openView(MANUAL_SYNC_VIEW_ID);

		await Event.toPromise(Event.filter(this.userDataSyncPreview.onDidChangeChanges, e => e.length === 0));
		if (this.userDataSyncPreview.conflicts.length) {
			await Event.toPromise(Event.filter(this.userDataSyncPreview.onDidChangeConflicts, e => e.length === 0));
		}

		/* Merge to sync globalState changes */
		await task.merge();

		if (visibleViewContainer) {
			this.viewsService.openViewContainer(visibleViewContainer.id);
		} else {
			const viewContainer = this.viewDescriptorService.getViewContainerByViewId(MANUAL_SYNC_VIEW_ID);
			this.viewsService.closeViewContainer(viewContainer!.id);
		}
	}

	private isSupportedAuthenticationProviderId(authenticationProviderId: string): boolean {
		return this.authenticationProviders.some(({ id }) => id === authenticationProviderId);
	}

	private isCurrentAccount(account: UserDataSyncAccount): boolean {
		return account.sessionId === this.currentSessionId;
	}

	async signIn(): Promise<void> {
		await this.pick();
	}

	private async pick(): Promise<boolean> {
		const result = await this.doPick();
		if (!result) {
			return false;
		}
		let sessionId: string, accountName: string, accountId: string;
		if (isAuthenticationProvider(result)) {
			const session = await this.authenticationService.login(result.id, result.scopes);
			sessionId = session.id;
			accountName = session.account.label;
			accountId = session.account.id;
		} else {
			sessionId = result.sessionId;
			accountName = result.accountName;
			accountId = result.accountId;
		}
		await this.switch(sessionId, accountName, accountId);
		return true;
	}

	private async doPick(): Promise<UserDataSyncAccount | IAuthenticationProvider | undefined> {
		if (this.authenticationProviders.length === 0) {
			return undefined;
		}

		await this.update();

		// Single auth provider and no accounts available
		if (this.authenticationProviders.length === 1 && !this.all.length) {
			return this.authenticationProviders[0];
		}

		return new Promise<UserDataSyncAccount | IAuthenticationProvider | undefined>(async (c, e) => {
			let result: UserDataSyncAccount | IAuthenticationProvider | undefined;
			const disposables: DisposableStore = new DisposableStore();
			const quickPick = this.quickInputService.createQuickPick<AccountQuickPickItem>();
			disposables.add(quickPick);

			quickPick.title = localize('pick an account', "Preferences Sync");
			quickPick.ok = false;
			quickPick.placeholder = localize('choose account placeholder', "Select an account");
			quickPick.ignoreFocusOut = true;
			quickPick.items = this.createQuickpickItems();

			disposables.add(quickPick.onDidAccept(() => {
				result = quickPick.selectedItems[0]?.account ? quickPick.selectedItems[0]?.account : quickPick.selectedItems[0]?.authenticationProvider;
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidHide(() => {
				disposables.dispose();
				c(result);
			}));
			quickPick.show();
		});
	}

	private createQuickpickItems(): (AccountQuickPickItem | IQuickPickSeparator)[] {
		const quickPickItems: (AccountQuickPickItem | IQuickPickSeparator)[] = [];

		// Signed in Accounts
		if (this.all.length) {
			const authenticationProviders = [...this.authenticationProviders].sort(({ id }) => id === this.current?.authenticationProviderId ? -1 : 1);
			quickPickItems.push({ type: 'separator', label: localize('signed in', "Signed in") });
			for (const authenticationProvider of authenticationProviders) {
				const accounts = (this._all.get(authenticationProvider.id) || []).sort(({ sessionId }) => sessionId === this.current?.sessionId ? -1 : 1);
				const providerName = this.authenticationService.getLabel(authenticationProvider.id);
				for (const account of accounts) {
					quickPickItems.push({
						label: `${account.accountName} (${providerName})`,
						description: account.sessionId === this.current?.sessionId ? localize('last used', "Last Used with Sync") : undefined,
						account,
						authenticationProvider,
					});
				}
			}
			quickPickItems.push({ type: 'separator', label: localize('others', "Others") });
		}

		// Account proviers
		for (const authenticationProvider of this.authenticationProviders) {
			const signedInForProvider = this.all.some(account => account.authenticationProviderId === authenticationProvider.id);
			if (!signedInForProvider || this.authenticationService.supportsMultipleAccounts(authenticationProvider.id)) {
				const providerName = this.authenticationService.getLabel(authenticationProvider.id);
				quickPickItems.push({ label: localize('sign in using account', "Sign in with {0}", providerName), authenticationProvider });
			}
		}

		return quickPickItems;
	}

	private async switch(sessionId: string, accountName: string, accountId: string): Promise<void> {
		const currentAccount = this.current;
		if (this.userDataAutoSyncService.isEnabled() && (currentAccount && currentAccount.accountName !== accountName)) {
			// accounts are switched while sync is enabled.
		}
		this.currentSessionId = sessionId;
		this.telemetryService.publicLog2<UserAccountEvent, UserAccountClassification>('sync.userAccount', { id: accountId });
		await this.update();
	}

	private async onDidSuccessiveAuthFailures(): Promise<void> {
		this.telemetryService.publicLog2('sync/successiveAuthFailures');
		this.currentSessionId = undefined;
		await this.update();

		this.notificationService.notify({
			severity: Severity.Error,
			message: localize('successive auth failures', "Preferences sync was turned off because of successive authorization failures. Please sign in again to continue synchronizing"),
			actions: {
				primary: [new Action('sign in', localize('sign in', "Sign in"), undefined, true, () => this.signIn())]
			}
		});
	}

	private onDidChangeSessions(e: AuthenticationSessionsChangeEvent): void {
		if (this.currentSessionId && e.removed.includes(this.currentSessionId)) {
			this.currentSessionId = undefined;
		}
		this.update();
	}

	private onDidChangeStorage(e: IWorkspaceStorageChangeEvent): void {
		if (e.key === UserDataSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY && e.scope === StorageScope.GLOBAL
			&& this.currentSessionId !== this.getStoredCachedSessionId() /* This checks if current window changed the value or not */) {
			this._cachedCurrentSessionId = null;
			this.update();
		}
	}

	private _cachedCurrentSessionId: string | undefined | null = null;
	private get currentSessionId(): string | undefined {
		if (this._cachedCurrentSessionId === null) {
			this._cachedCurrentSessionId = this.getStoredCachedSessionId();
		}
		return this._cachedCurrentSessionId;
	}

	private set currentSessionId(cachedSessionId: string | undefined) {
		if (this._cachedCurrentSessionId !== cachedSessionId) {
			this._cachedCurrentSessionId = cachedSessionId;
			if (cachedSessionId === undefined) {
				this.storageService.remove(UserDataSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
			} else {
				this.storageService.store(UserDataSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, cachedSessionId, StorageScope.GLOBAL);
			}
		}
	}

	private getStoredCachedSessionId(): string | undefined {
		return this.storageService.get(UserDataSyncWorkbenchService.CACHED_SESSION_STORAGE_KEY, StorageScope.GLOBAL);
	}

	private get useWorkbenchSessionId(): boolean {
		return !this.storageService.getBoolean(UserDataSyncWorkbenchService.DONOT_USE_WORKBENCH_SESSION_STORAGE_KEY, StorageScope.GLOBAL, false);
	}

	private set useWorkbenchSessionId(useWorkbenchSession: boolean) {
		this.storageService.store(UserDataSyncWorkbenchService.DONOT_USE_WORKBENCH_SESSION_STORAGE_KEY, !useWorkbenchSession, StorageScope.GLOBAL);
	}

}

class UserDataSyncPreview extends Disposable implements IUserDataSyncPreview, IDecorationsProvider {

	readonly label: string = localize('label', "UserDataSyncResources");

	private readonly _onDidChange = this._register(new Emitter<URI[]>());
	readonly onDidChange = this._onDidChange.event;

	private _onDidChangeChanges = this._register(new Emitter<ReadonlyArray<IUserDataSyncResourceGroup>>());
	readonly onDidChangeChanges = this._onDidChangeChanges.event;

	private _onDidChangeConflicts = this._register(new Emitter<ReadonlyArray<IUserDataSyncResourceGroup>>());
	readonly onDidChangeConflicts = this._onDidChangeConflicts.event;

	private _changes: ReadonlyArray<IUserDataSyncResourceGroup> = [];
	get changes() { return Object.freeze(this._changes); }

	private _conflicts: ReadonlyArray<IUserDataSyncResourceGroup> = [];
	get conflicts() { return Object.freeze(this._conflicts); }

	private manualSync: { preview: [SyncResource, ISyncResourcePreview][], task: IManualSyncTask } | undefined;

	constructor(
		private readonly userDataSyncService: IUserDataSyncService
	) {
		super();
		this.updateConflicts(userDataSyncService.conflicts);
		this._register(userDataSyncService.onDidChangeConflicts(conflicts => this.updateConflicts(conflicts)));
	}

	setManualSyncPreview(task: IManualSyncTask, preview: [SyncResource, ISyncResourcePreview][]): void {
		this.manualSync = { task, preview };
		this.updateChanges();
	}

	async accept(syncResource: SyncResource, resource: URI, content: string): Promise<void> {
		if (this.manualSync) {
			const syncPreview = await this.manualSync.task.accept(resource, content);
			this.updatePreview(syncPreview);
		} else {
			await this.userDataSyncService.acceptPreviewContent(syncResource, resource, content);
		}
	}

	async merge(resource?: URI): Promise<void> {
		if (!this.manualSync) {
			throw new Error('Can merge only while syncing manually');
		}
		const syncPreview = await this.manualSync.task.merge(resource);
		this.updatePreview(syncPreview);
	}

	async pull(): Promise<void> {
		if (!this.manualSync) {
			throw new Error('Can pull only while syncing manually');
		}
		await this.manualSync.task.pull();
		this.updatePreview([]);
	}

	async push(): Promise<void> {
		if (!this.manualSync) {
			throw new Error('Can push only while syncing manually');
		}
		await this.manualSync.task.push();
		this.updatePreview([]);
	}

	provideDecorations(resource: URI): IDecorationData | undefined {
		const changeResource = this.changes.find(c => isEqual(c.remote, resource)) || this.conflicts.find(c => isEqual(c.remote, resource));
		if (changeResource) {
			if (changeResource.localChange === Change.Modified || changeResource.remoteChange === Change.Modified) {
				return {
					letter: 'M',
				};
			}
			if (changeResource.localChange === Change.Added
				|| changeResource.localChange === Change.Deleted
				|| changeResource.remoteChange === Change.Added
				|| changeResource.remoteChange === Change.Deleted) {
				return {
					letter: 'A',
				};
			}
		}
		return undefined;
	}

	private updatePreview(preview: [SyncResource, ISyncResourcePreview][]) {
		if (this.manualSync) {
			this.manualSync.preview = preview;
			this.updateChanges();
		}
	}

	private updateConflicts(conflicts: [SyncResource, IResourcePreview[]][]): void {
		const newConflicts = this.toUserDataSyncResourceGroups(conflicts);
		if (!equals(newConflicts, this._conflicts, (a, b) => isEqual(a.local, b.local))) {
			this._conflicts = newConflicts;
			this._onDidChangeConflicts.fire(this.conflicts);
		}
		this.updateChanges();
	}

	private updateChanges(): void {
		const newChanges = this.toUserDataSyncResourceGroups(
			(this.manualSync?.preview || [])
				.filter(([syncResource]) => syncResource !== SyncResource.GlobalState) /* Filter Global State Changes */
				.map(([syncResource, syncResourcePreview]) =>
					([
						syncResource,
						/* remove merged previews and conflicts and with no changes and conflicts */
						syncResourcePreview.resourcePreviews.filter(r =>
							!r.merged
							&& (r.localChange !== Change.None || r.remoteChange !== Change.None)
							&& !this._conflicts.some(c => c.syncResource === syncResource && isEqual(c.local, r.localResource)))
					]))
		);
		if (!equals(newChanges, this._changes, (a, b) => isEqual(a.local, b.local))) {
			this._changes = newChanges;
			this._onDidChangeChanges.fire(this.changes);
		}
	}

	private toUserDataSyncResourceGroups(syncResourcePreviews: [SyncResource, IResourcePreview[]][]): IUserDataSyncResourceGroup[] {
		return flatten(
			syncResourcePreviews.map(([syncResource, resourcePreviews]) =>
				resourcePreviews.map<IUserDataSyncResourceGroup>(({ localResource, remoteResource, previewResource, localChange, remoteChange }) =>
					({ syncResource, local: localResource, remote: remoteResource, preview: previewResource, localChange, remoteChange })))
		);
	}

}

registerSingleton(IUserDataSyncWorkbenchService, UserDataSyncWorkbenchService);
