import React, { useState, useEffect, useCallback } from 'react';

import { StyleSheet, Alert, InteractionManager } from 'react-native';
import PropTypes from 'prop-types';
import { connect, useSelector } from 'react-redux';
import Approval from '../../Views/Approval';
import NotificationManager from '../../../core/NotificationManager';
import Engine from '../../../core/Engine';
import { strings } from '../../../../locales/i18n';
import { hexToBN, fromWei } from '../../../util/number';
import { setEtherTransaction, setTransactionObject } from '../../../actions/transaction';
import PersonalSign from '../../UI/PersonalSign';
import TypedSign from '../../UI/TypedSign';
import Modal from 'react-native-modal';
import WalletConnect from '../../../core/WalletConnect';
import {
	getMethodData,
	TOKEN_METHOD_TRANSFER,
	APPROVE_FUNCTION_SIGNATURE,
	decodeApproveData,
	getTokenValueParam,
	getTokenAddressParam,
	calcTokenAmount,
	getTokenValueParamAsHex,
} from '../../../util/transactions';
import { BN } from 'ethereumjs-util';
import Logger from '../../../util/Logger';
import MessageSign from '../../UI/MessageSign';
import Approve from '../../Views/ApproveView/Approve';
import TransactionTypes from '../../../core/TransactionTypes';
import { toggleDappTransactionModal, toggleApproveModal } from '../../../actions/modals';
import AccountApproval from '../../UI/AccountApproval';
import { swapsUtils } from '@metamask/swaps-controller';
import { util } from '@metamask/controllers';
import Analytics from '../../../core/Analytics';
import { ANALYTICS_EVENT_OPTS } from '../../../util/analytics';
import BigNumber from 'bignumber.js';
import { getTokenList } from '../../../reducers/tokens';
import { toLowerCaseEquals } from '../../../util/general';
import { ethers } from 'ethers';
import abi from 'human-standard-token-abi';
import AddCustomNetwork from '../../UI/AddCustomNetwork';
import SwitchCustomNetwork from '../../UI/SwitchCustomNetwork';
import { ethErrors } from 'eth-json-rpc-errors';

const hstInterface = new ethers.utils.Interface(abi);

const styles = StyleSheet.create({
	bottomModal: {
		justifyContent: 'flex-end',
		margin: 0,
	},
});
const RootComponents = (props) => {
	const [signMessage, setSignMessage] = useState(false);
	const [signMessageParams, setSignMessageParams] = useState({ data: '' });
	const [signType, setSignType] = useState(false);
	const [walletConnectRequest, setWalletConnectRequest] = useState(false);
	const [walletConnectRequestInfo, setWalletConnectRequestInfo] = useState(false);
	const [showExpandedMessage, setShowExpandedMessage] = useState(false);
	const [currentPageMeta, setCurrentPageMeta] = useState({});

	const tokenList = useSelector(getTokenList);

	const [customNetworkToAdd, setCustomNetworkToAdd] = useState(null);
	const [showAddCustomNetworkDialog, setShowAddCustomNetworkDialog] = useState(false);
	const [customNetworkToSwitch, setCustomNetworkToSwitch] = useState(null);
	const [showSwitchCustomNetworkDialog, setShowSwitchCustomNetworkDialog] = useState(undefined);

	const setTransactionObject = props.setTransactionObject;
	const toggleApproveModal = props.toggleApproveModal;
	const toggleDappTransactionModal = props.toggleDappTransactionModal;
	const setEtherTransaction = props.setEtherTransaction;

	const onUnapprovedMessage = (messageParams, type) => {
		setCurrentPageMeta(messageParams.meta);
		delete messageParams.meta;
		setSignMessageParams(messageParams);
		setSignType(type);
		setSignMessage(true);
	};

	const initializeWalletConnect = () => {
		WalletConnect.hub.on('walletconnectSessionRequest', (peerInfo) => {
			setWalletConnectRequest(true);
			setWalletConnectRequestInfo(peerInfo);
		});
		WalletConnect.init();
	};

	const trackSwaps = useCallback(
		async (event, transactionMeta) => {
			try {
				const { TransactionController } = Engine.context;
				const newSwapsTransactions = props.swapsTransactions;
				const swapTransaction = newSwapsTransactions[transactionMeta.id];
				const { sentAt, gasEstimate, ethAccountBalance, approvalTransactionMetaId } =
					swapTransaction.paramsForAnalytics;

				const approvalTransaction = TransactionController.state.transactions.find(
					({ id }) => id === approvalTransactionMetaId
				);
				const ethBalance = await util.query(TransactionController.ethQuery, 'getBalance', [
					props.selectedAddress,
				]);
				const receipt = await util.query(TransactionController.ethQuery, 'getTransactionReceipt', [
					transactionMeta.transactionHash,
				]);

				const currentBlock = await util.query(TransactionController.ethQuery, 'getBlockByHash', [
					receipt.blockHash,
					false,
				]);
				let approvalReceipt;
				if (approvalTransaction?.transactionHash) {
					approvalReceipt = await util.query(TransactionController.ethQuery, 'getTransactionReceipt', [
						approvalTransaction.transactionHash,
					]);
				}
				const tokensReceived = swapsUtils.getSwapsTokensReceived(
					receipt,
					approvalReceipt,
					transactionMeta?.transaction,
					approvalTransaction?.transaction,
					swapTransaction.destinationToken,
					ethAccountBalance,
					ethBalance
				);

				newSwapsTransactions[transactionMeta.id].gasUsed = receipt.gasUsed;
				if (tokensReceived) {
					newSwapsTransactions[transactionMeta.id].receivedDestinationAmount = new BigNumber(
						tokensReceived,
						16
					).toString(10);
				}
				TransactionController.update({ swapsTransactions: newSwapsTransactions });

				const timeToMine = currentBlock.timestamp - sentAt;
				const estimatedVsUsedGasRatio = `${new BigNumber(receipt.gasUsed)
					.div(gasEstimate)
					.times(100)
					.toFixed(2)}%`;
				const quoteVsExecutionRatio = `${swapsUtils
					.calcTokenAmount(tokensReceived || '0x0', swapTransaction.destinationTokenDecimals)
					.div(swapTransaction.destinationAmount)
					.times(100)
					.toFixed(2)}%`;
				const tokenToAmountReceived = swapsUtils.calcTokenAmount(
					tokensReceived,
					swapTransaction.destinationToken.decimals
				);
				const analyticsParams = { ...swapTransaction.analytics };
				delete newSwapsTransactions[transactionMeta.id].analytics;
				delete newSwapsTransactions[transactionMeta.id].paramsForAnalytics;

				InteractionManager.runAfterInteractions(() => {
					const parameters = {
						...analyticsParams,
						time_to_mine: timeToMine,
						estimated_vs_used_gasRatio: estimatedVsUsedGasRatio,
						quote_vs_executionRatio: quoteVsExecutionRatio,
						token_to_amount_received: tokenToAmountReceived.toString(),
					};
					Analytics.trackEventWithParameters(event, {});
					Analytics.trackEventWithParameters(event, parameters, true);
				});
			} catch (e) {
				Logger.error(e, ANALYTICS_EVENT_OPTS.SWAP_TRACKING_FAILED);
				InteractionManager.runAfterInteractions(() => {
					Analytics.trackEvent(ANALYTICS_EVENT_OPTS.SWAP_TRACKING_FAILED, { error: e });
				});
			}
		},
		[props.selectedAddress, props.swapsTransactions]
	);

	const autoSign = useCallback(
		async (transactionMeta) => {
			const { TransactionController } = Engine.context;
			try {
				TransactionController.hub.once(`${transactionMeta.id}:finished`, (transactionMeta) => {
					if (transactionMeta.status === 'submitted') {
						NotificationManager.watchSubmittedTransaction({
							...transactionMeta,
							assetType: transactionMeta.transaction.assetType,
						});
					} else {
						if (props.swapsTransactions[transactionMeta.id]?.analytics) {
							trackSwaps(ANALYTICS_EVENT_OPTS.SWAP_FAILED, transactionMeta);
						}
						throw transactionMeta.error;
					}
				});
				TransactionController.hub.once(`${transactionMeta.id}:confirmed`, (transactionMeta) => {
					if (props.swapsTransactions[transactionMeta.id]?.analytics) {
						trackSwaps(ANALYTICS_EVENT_OPTS.SWAP_COMPLETED, transactionMeta);
					}
				});
				await TransactionController.approveTransaction(transactionMeta.id);
			} catch (error) {
				Alert.alert(strings('transactions.transaction_error'), error && error.message, [
					{ text: strings('navigation.ok') },
				]);
				Logger.error(error, 'error while trying to send transaction (Main)');
			}
		},
		[props.swapsTransactions, trackSwaps]
	);

	const onUnapprovedTransaction = useCallback(
		async (transactionMeta) => {
			if (transactionMeta.origin === TransactionTypes.MMM) return;

			const to = transactionMeta.transaction.to?.toLowerCase();
			const { data } = transactionMeta.transaction;

			// if approval data includes metaswap contract
			// if destination address is metaswap contract
			if (
				transactionMeta.origin === process.env.MM_FOX_CODE &&
				to &&
				(swapsUtils.isValidContractAddress(props.chainId, to) ||
					(data &&
						data.substr(0, 10) === APPROVE_FUNCTION_SIGNATURE &&
						decodeApproveData(data).spenderAddress?.toLowerCase() ===
							swapsUtils.getSwapsContractAddress(props.chainId)))
			) {
				autoSign(transactionMeta);
			} else {
				const {
					transaction: { value, gas, gasPrice, data },
				} = transactionMeta;
				const { AssetsContractController } = Engine.context;
				transactionMeta.transaction.gas = hexToBN(gas);
				transactionMeta.transaction.gasPrice = hexToBN(gasPrice);
				if (
					(value === '0x0' || !value) &&
					data &&
					data !== '0x' &&
					to &&
					(await getMethodData(data)).name === TOKEN_METHOD_TRANSFER
				) {
					let asset = props.tokens.find(({ address }) => toLowerCaseEquals(address, to));
					if (!asset) {
						// try to lookup contract by lowercased address `to`
						asset = tokenList[to];

						if (!asset) {
							try {
								asset = {};
								asset.decimals = await AssetsContractController.getTokenDecimals(to);
								asset.symbol = await AssetsContractController.getAssetSymbol(to);
								// adding `to` here as well
								asset.address = to;
							} catch (e) {
								// This could fail when requesting a transfer in other network
								// adding `to` here as well
								asset = { symbol: 'ERC20', decimals: new BN(0), address: to };
							}
						}
					}

					const tokenData = hstInterface.parseTransaction({ data });
					const tokenValue = getTokenValueParam(tokenData);
					const toAddress = getTokenAddressParam(tokenData);
					const tokenAmount = tokenData && calcTokenAmount(tokenValue, asset.decimals).toFixed();

					transactionMeta.transaction.value = hexToBN(getTokenValueParamAsHex(tokenData));
					transactionMeta.transaction.readableValue = tokenAmount;
					transactionMeta.transaction.to = toAddress;

					setTransactionObject({
						type: 'INDIVIDUAL_TOKEN_TRANSACTION',
						selectedAsset: asset,
						id: transactionMeta.id,
						origin: transactionMeta.origin,
						...transactionMeta.transaction,
					});
				} else {
					transactionMeta.transaction.value = hexToBN(value);
					transactionMeta.transaction.readableValue = fromWei(transactionMeta.transaction.value);

					setEtherTransaction({
						id: transactionMeta.id,
						origin: transactionMeta.origin,
						...transactionMeta.transaction,
					});
				}

				if (data && data.substr(0, 10) === APPROVE_FUNCTION_SIGNATURE) {
					toggleApproveModal();
				} else {
					toggleDappTransactionModal();
				}
			}
		},
		[
			props.tokens,
			props.chainId,
			setEtherTransaction,
			setTransactionObject,
			toggleApproveModal,
			toggleDappTransactionModal,
			autoSign,
			tokenList,
		]
	);

	const onSignAction = () => setSignMessage(false);

	const toggleExpandedMessage = () => setShowExpandedMessage(!showExpandedMessage);

	const renderSigningModal = () => (
		<Modal
			isVisible={signMessage}
			animationIn="slideInUp"
			animationOut="slideOutDown"
			style={styles.bottomModal}
			backdropOpacity={0.7}
			animationInTiming={600}
			animationOutTiming={600}
			onBackdropPress={onSignAction}
			onBackButtonPress={showExpandedMessage ? toggleExpandedMessage : onSignAction}
			onSwipeComplete={onSignAction}
			swipeDirection={'down'}
			propagateSwipe
		>
			{signType === 'personal' && (
				<PersonalSign
					navigation={props.navigation}
					messageParams={signMessageParams}
					onCancel={onSignAction}
					onConfirm={onSignAction}
					currentPageInformation={currentPageMeta}
					toggleExpandedMessage={toggleExpandedMessage}
					showExpandedMessage={showExpandedMessage}
				/>
			)}
			{signType === 'typed' && (
				<TypedSign
					navigation={props.navigation}
					messageParams={signMessageParams}
					onCancel={onSignAction}
					onConfirm={onSignAction}
					currentPageInformation={currentPageMeta}
					toggleExpandedMessage={toggleExpandedMessage}
					showExpandedMessage={showExpandedMessage}
				/>
			)}
			{signType === 'eth' && (
				<MessageSign
					navigation={props.navigation}
					messageParams={signMessageParams}
					onCancel={onSignAction}
					onConfirm={onSignAction}
					currentPageInformation={currentPageMeta}
					toggleExpandedMessage={toggleExpandedMessage}
					showExpandedMessage={showExpandedMessage}
				/>
			)}
		</Modal>
	);

	const onWalletConnectSessionApproval = () => {
		const { peerId } = walletConnectRequestInfo;
		setWalletConnectRequest(false);
		setWalletConnectRequestInfo({});
		WalletConnect.hub.emit('walletconnectSessionRequest::approved', peerId);
	};

	const onWalletConnectSessionRejected = () => {
		const peerId = walletConnectRequestInfo.peerId;
		setWalletConnectRequest(false);
		setWalletConnectRequestInfo({});
		WalletConnect.hub.emit('walletconnectSessionRequest::rejected', peerId);
	};

	const renderWalletConnectSessionRequestModal = () => {
		const meta = walletConnectRequestInfo.peerMeta || null;
		return (
			<Modal
				isVisible={walletConnectRequest}
				animationIn="slideInUp"
				animationOut="slideOutDown"
				style={styles.bottomModal}
				backdropOpacity={0.7}
				animationInTiming={300}
				animationOutTiming={300}
				onSwipeComplete={onWalletConnectSessionRejected}
				onBackButtonPress={onWalletConnectSessionRejected}
				swipeDirection={'down'}
			>
				<AccountApproval
					onCancel={onWalletConnectSessionRejected}
					onConfirm={onWalletConnectSessionApproval}
					currentPageInformation={{
						title: meta && meta.name,
						url: meta && meta.url,
					}}
					walletConnectRequest
				/>
			</Modal>
		);
	};

	const renderDappTransactionModal = () =>
		props.dappTransactionModalVisible && (
			<Approval
				navigation={props.navigation}
				dappTransactionModalVisible
				toggleDappTransactionModal={props.toggleDappTransactionModal}
			/>
		);

	const renderApproveModal = () =>
		props.approveModalVisible && <Approve modalVisible toggleApproveModal={props.toggleApproveModal} />;

	const rejectPendingApproval = (id, error) => {
		const { ApprovalController } = Engine.context;
		ApprovalController.reject(id, error);
	};

	const acceptPendingApproval = (id, requestData) => {
		const { ApprovalController } = Engine.context;
		ApprovalController.accept(id, requestData);
	};

	const onAddCustomNetworkReject = () => {
		setShowAddCustomNetworkDialog(false);
		rejectPendingApproval(customNetworkToAdd.id, ethErrors.provider.userRejectedRequest());
	};

	const onAddCustomNetworkConfirm = () => {
		setShowAddCustomNetworkDialog(false);
		acceptPendingApproval(customNetworkToAdd.id, customNetworkToAdd.data);
	};

	/**
	 * Render the modal that asks the user to approve/reject connections to a dapp
	 */
	const renderAddCustomNetworkModal = () => (
		<Modal
			isVisible={showAddCustomNetworkDialog}
			animationIn="slideInUp"
			animationOut="slideOutDown"
			style={styles.bottomModal}
			backdropOpacity={0.7}
			animationInTiming={300}
			animationOutTiming={300}
			onSwipeComplete={onAddCustomNetworkReject}
			onBackdropPress={onAddCustomNetworkReject}
		>
			<AddCustomNetwork
				onCancel={onAddCustomNetworkReject}
				onConfirm={onAddCustomNetworkConfirm}
				currentPageInformation={currentPageMeta}
				customNetworkInformation={customNetworkToAdd?.data}
			/>
		</Modal>
	);

	const onSwitchCustomNetworkReject = () => {
		setShowSwitchCustomNetworkDialog(undefined);
		rejectPendingApproval(customNetworkToSwitch.id, ethErrors.provider.userRejectedRequest());
	};

	const onSwitchCustomNetworkConfirm = () => {
		setShowSwitchCustomNetworkDialog(undefined);
		acceptPendingApproval(customNetworkToSwitch.id, customNetworkToSwitch.data);
	};

	/**
	 * Render the modal that asks the user to approve/reject connections to a dapp
	 */
	const renderSwitchCustomNetworkModal = () => (
		<Modal
			isVisible={!!showSwitchCustomNetworkDialog}
			animationIn="slideInUp"
			animationOut="slideOutDown"
			style={styles.bottomModal}
			backdropOpacity={0.7}
			animationInTiming={300}
			animationOutTiming={300}
			onSwipeComplete={onSwitchCustomNetworkReject}
			onBackdropPress={onSwitchCustomNetworkReject}
			swipeDirection={'down'}
		>
			<SwitchCustomNetwork
				onCancel={onSwitchCustomNetworkReject}
				onConfirm={onSwitchCustomNetworkConfirm}
				currentPageInformation={currentPageMeta}
				customNetworkInformation={customNetworkToSwitch?.data}
				type={showSwitchCustomNetworkDialog}
			/>
		</Modal>
	);

	// unapprovedTransaction effect
	useEffect(() => {
		Engine.context.TransactionController.hub.on('unapprovedTransaction', onUnapprovedTransaction);
		return () => {
			Engine.context.TransactionController.hub.removeListener('unapprovedTransaction', onUnapprovedTransaction);
		};
	}, [onUnapprovedTransaction]);

	const handlePendingApprovals = async (approval) => {
		if (approval.pendingApprovalCount > 0) {
			const key = Object.keys(approval.pendingApprovals)[0];
			const request = approval.pendingApprovals[key];
			const requestData = request.requestData;
			if (requestData.pageMeta) {
				setCurrentPageMeta(requestData.pageMeta);
			}
			switch (request.type) {
				case 'SWITCH_ETHEREUM_CHAIN':
					setCustomNetworkToSwitch({ data: requestData, id: request.id });
					setShowSwitchCustomNetworkDialog(requestData.type);
					break;
				case 'ADD_ETHEREUM_CHAIN':
					setCustomNetworkToAdd({ data: requestData, id: request.id });
					setShowAddCustomNetworkDialog(true);
					break;
				default:
					break;
			}
		}
	};

	useEffect(() => {
		initializeWalletConnect();

		Engine.context.MessageManager.hub.on('unapprovedMessage', (messageParams) =>
			onUnapprovedMessage(messageParams, 'eth')
		);

		Engine.context.PersonalMessageManager.hub.on('unapprovedMessage', (messageParams) =>
			onUnapprovedMessage(messageParams, 'personal')
		);

		Engine.context.TypedMessageManager.hub.on('unapprovedMessage', (messageParams) =>
			onUnapprovedMessage(messageParams, 'typed')
		);

		Engine.controllerMessenger.subscribe('ApprovalController:stateChange', handlePendingApprovals);

		return function cleanup() {
			Engine.context.PersonalMessageManager.hub.removeAllListeners();
			Engine.context.TypedMessageManager.hub.removeAllListeners();
			Engine.controllerMessenger.unsubscribe('ApprovalController:stateChange', handlePendingApprovals);
			WalletConnect.hub.removeAllListeners();
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<React.Fragment>
			{renderSigningModal()}
			{renderWalletConnectSessionRequestModal()}
			{renderDappTransactionModal()}
			{renderApproveModal()}
			{renderAddCustomNetworkModal()}
			{renderSwitchCustomNetworkModal()}
		</React.Fragment>
	);
};

RootComponents.propTypes = {
	swapsTransactions: PropTypes.object,
	/**
	 * Object that represents the navigator
	 */
	navigation: PropTypes.object,
	/**
	 * Action that sets an ETH transaction
	 */
	setEtherTransaction: PropTypes.func,
	/**
	 * Action that sets a transaction
	 */
	setTransactionObject: PropTypes.func,
	/**
	 * Array of ERC20 assets
	 */
	tokens: PropTypes.array,
	/**
	/* Hides or shows dApp transaction modal
	*/
	toggleDappTransactionModal: PropTypes.func,
	/**
	/* Hides or shows approve modal
	*/
	toggleApproveModal: PropTypes.func,
	/**
	/* dApp transaction modal visible or not
	*/
	dappTransactionModalVisible: PropTypes.bool,
	/**
	/* Token approve modal visible or not
	*/
	approveModalVisible: PropTypes.bool,
	/**
	 * Selected address
	 */
	selectedAddress: PropTypes.string,
	/**
	 * Chain id
	 */
	chainId: PropTypes.string,
};

const mapStateToProps = (state) => ({
	selectedAddress: state.engine.backgroundState.PreferencesController.selectedAddress,
	chainId: state.engine.backgroundState.NetworkController.provider.chainId,
	tokens: state.engine.backgroundState.TokensController.tokens,
	dappTransactionModalVisible: state.modals.dappTransactionModalVisible,
	approveModalVisible: state.modals.approveModalVisible,
	swapsTransactions: state.engine.backgroundState.TransactionController.swapsTransactions || {},
	providerType: state.engine.backgroundState.NetworkController.provider.type,
});

const mapDispatchToProps = (dispatch) => ({
	setEtherTransaction: (transaction) => dispatch(setEtherTransaction(transaction)),
	setTransactionObject: (transaction) => dispatch(setTransactionObject(transaction)),
	toggleDappTransactionModal: (show = null) => dispatch(toggleDappTransactionModal(show)),
	toggleApproveModal: (show) => dispatch(toggleApproveModal(show)),
});

export default connect(mapStateToProps, mapDispatchToProps)(RootComponents);
