import { BasicMessageRecord, CredentialExchangeRecord, ProofExchangeRecord, SdJwtVcRecord, W3cCredentialRecord } from '@credo-ts/core'
import { CommonActions } from '@react-navigation/native'
import { StackScreenProps } from '@react-navigation/stack'
import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AccessibilityInfo, BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import Button, { ButtonType } from '../components/buttons/Button'
import { useAnimatedComponents } from '../contexts/animated-components'
import { useTheme } from '../contexts/theme'
import { useConnectionByOutOfBandId, useOutOfBandById } from '../hooks/connections'
import { DeliveryStackParams, Screens, Stacks, TabStacks } from '../types/navigators'
import { testIdWithKey } from '../utils/testable'

import { useServices, TOKENS } from './../container-api'

type ConnectionProps = StackScreenProps<DeliveryStackParams, Screens.Connection>

type MergeFunction = (current: LocalState, next: Partial<LocalState>) => LocalState

type LocalState = {
  inProgress: boolean
  notificationRecord?: any
  shouldShowDelayMessage: boolean
}

const GoalCodes = {
  proofRequestVerify: 'aries.vc.verify',
  proofRequestVerifyOnce: 'aries.vc.verify.once',
  credentialOffer: 'aries.vc.issue',
} as const

const Connection: React.FC<ConnectionProps> = ({ navigation, route }) => {
  const { oobRecordId, openIDUri } = route.params
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const { t } = useTranslation()
  const { ColorPallet, TextTheme } = useTheme()
  const { ConnectionLoading } = useAnimatedComponents()
  const [logger, { useNotifications }, { connectionTimerDelay, autoRedirectConnectionToHome }] = useServices([TOKENS.UTIL_LOGGER, TOKENS.NOTIFICATIONS, TOKENS.CONFIG])
  const connTimerDelay = connectionTimerDelay ?? 10000 // in ms
  const notifications = useNotifications({openIDUri: openIDUri})
  const oobRecord = useOutOfBandById(oobRecordId)
  const connection = useConnectionByOutOfBandId(oobRecordId)
  const merge: MergeFunction = (current, next) => ({ ...current, ...next })
  const [state, dispatch] = useReducer(merge, {
    inProgress: true,
    shouldShowDelayMessage: false,
    notificationRecord: undefined,
  })
  const styles = StyleSheet.create({
    container: {
      height: '100%',
      backgroundColor: ColorPallet.brand.modalPrimaryBackground,
      padding: 20,
    },
    image: {
      marginTop: 20,
    },
    messageContainer: {
      alignItems: 'center',
    },
    messageText: {
      fontWeight: TextTheme.normal.fontWeight,
      textAlign: 'center',
      marginTop: 30,
    },
    controlsContainer: {
      marginTop: 'auto',
      margin: 20,
    },
    delayMessageText: {
      textAlign: 'center',
      marginTop: 20,
    },
  })

  const startTimer = useCallback(() => {
    timerRef.current = setTimeout(() => {
      dispatch({ shouldShowDelayMessage: true })
      timerRef.current = null
    }, connTimerDelay)

  }, [dispatch, connTimerDelay])

  const abortTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onDismissModalTouched = useCallback(() => {
    dispatch({ shouldShowDelayMessage: false, inProgress: false })
    navigation.getParent()?.navigate(TabStacks.HomeStack, { screen: Screens.Home })
  }, [dispatch, navigation])

  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => backHandler.remove()
  }, [])

  useEffect(() => {
    if (state.shouldShowDelayMessage && !state.notificationRecord) {
      if (autoRedirectConnectionToHome) {
        dispatch({ shouldShowDelayMessage: false, inProgress: false })
        navigation.getParent()?.navigate(TabStacks.HomeStack, { screen: Screens.Home })
      } else {
        AccessibilityInfo.announceForAccessibility(t('Connection.TakingTooLong'))
      }
    }
  }, [state.shouldShowDelayMessage, state.notificationRecord, autoRedirectConnectionToHome, dispatch, navigation, t])

  useEffect(() => {
    if (!oobRecord || !state.inProgress) {
      return
    }

    // If we have a connection, but no goal code, we should navigate
    // to Chat
    if (connection && !(Object.values(GoalCodes) as [string]).includes(oobRecord?.outOfBandInvitation.goalCode ?? '')) {
      logger?.info('Connection: Handling connection without goal code, navigate to Chat')

      dispatch({ inProgress: false })
      navigation.getParent()?.dispatch(
        CommonActions.reset({
          index: 1,
          routes: [{ name: Stacks.TabStack }, { name: Screens.Chat, params: { connectionId: connection.id } }],
        })
      )

      return
    }

    // At this point we should be waiting for a notification
    // to be processed
    if (!state.notificationRecord) {
      return
    }

    // Connectionless proof request, we don't have connectionless offers.
    if (!connection) {
      dispatch({ inProgress: false })
      navigation.replace(Screens.ProofRequest, { proofId: state.notificationRecord.id })

      return
    }

    // At this point, we have connection based proof or offer with
    // a goal code.

    if (!oobRecord) {
      logger?.error(`Connection: No OOB record where one is expected`)

      return
    }

    const { goalCode } = oobRecord.outOfBandInvitation

    if (goalCode === GoalCodes.proofRequestVerify || goalCode === GoalCodes.proofRequestVerifyOnce) {
      logger?.info(`Connection: Handling ${goalCode} goal code, navigate to ProofRequest`)

      dispatch({ inProgress: false })
      navigation.replace(Screens.ProofRequest, { proofId: state.notificationRecord.id })

      return
    }

    if (goalCode === GoalCodes.credentialOffer) {
      logger?.info(`Connection: Handling ${goalCode} goal code, navigate to CredentialOffer`)

      dispatch({ inProgress: false })
      navigation.replace(Screens.CredentialOffer, { credentialId: state.notificationRecord.id })

      return
    }

    logger?.info(`Connection: Unable to handle ${goalCode} goal code`)

    dispatch({ inProgress: false })
    navigation.getParent()?.dispatch(
      CommonActions.reset({
        index: 1,
        routes: [{ name: Stacks.TabStack }, { name: Screens.Chat, params: { connectionId: connection.id } }],
      })
    )
  }, [oobRecord, state.inProgress, connection, logger, dispatch, navigation, state.notificationRecord])

  // This hook will monitor notification for openID type credentials where there is not connection or oobID present
  useEffect(() => {
    if (!state.inProgress) {
      return
    }

    if (!state.notificationRecord) {
      return
    }

    if((state.notificationRecord as W3cCredentialRecord).type === 'W3cCredentialRecord' || (state.notificationRecord as SdJwtVcRecord).type === 'SdJwtVcRecord') {
      logger?.info(`Connection: Handling OpenID4VCi Credential, navigate to CredentialOffer`)
      dispatch({ inProgress: false })
      navigation.replace(Screens.OpenIDCredentialDetails, { credential: state.notificationRecord })
      return
    }

  }, [state, logger, navigation])

  useEffect(() => {
    startTimer()
    return () => abortTimer()
  }, [startTimer, abortTimer])

  useEffect(() => {
    if (!state.inProgress || state.notificationRecord) {
      return
    }
    type notCustomNotification = BasicMessageRecord | CredentialExchangeRecord | ProofExchangeRecord
    for (const notification of notifications) {
      // no action taken for BasicMessageRecords
      if ((notification as BasicMessageRecord).type === 'BasicMessageRecord') {
        logger?.info('Connection: BasicMessageRecord, skipping')
        continue
      }

      if (
        (connection && (notification as notCustomNotification).connectionId === connection.id) ||
        oobRecord?.getTags()?.invitationRequestsThreadIds?.includes((notification as notCustomNotification)?.threadId ?? "")
      ) {
        logger?.info(`Connection: Handling notification ${(notification as notCustomNotification).id}`)

        dispatch({ notificationRecord: notification })
        break
      }

      if((notification as W3cCredentialRecord).type === 'W3cCredentialRecord') {
        dispatch({ notificationRecord: notification })
        break
      }

      if((notification as SdJwtVcRecord).type === 'SdJwtVcRecord') {
        dispatch({ notificationRecord: notification })
        break
      }

    }
  }, [state.inProgress, state.notificationRecord, notifications, logger, connection, oobRecord, dispatch])

  return (
    <SafeAreaView style={{ backgroundColor: ColorPallet.brand.modalPrimaryBackground }}>
      <ScrollView style={styles.container}>
        <View style={styles.messageContainer}>
          <Text style={[TextTheme.modalHeadingThree, styles.messageText]} testID={testIdWithKey('CredentialOnTheWay')}>
            {t('Connection.JustAMoment')}
          </Text>
        </View>

        <View style={styles.image}>
          <ConnectionLoading />
        </View>

        {state.shouldShowDelayMessage && (
          <Text style={[TextTheme.modalNormal, styles.delayMessageText]} testID={testIdWithKey('TakingTooLong')}>
            {t('Connection.TakingTooLong')}
          </Text>
        )}
      </ScrollView>
      <View style={styles.controlsContainer}>
        <Button
          title={t('Loading.BackToHome')}
          accessibilityLabel={t('Loading.BackToHome')}
          testID={testIdWithKey('BackToHome')}
          onPress={onDismissModalTouched}
          buttonType={ButtonType.ModalSecondary}
        />
      </View>
    </SafeAreaView>
  )
}

export default Connection
