class LoadingSpinner extends React.Component {
    render() {
        // Thanks to Jonathan Rajavuori from Eagan for the beautiful pure css implementation
        return <div className='loading-spinner-container'>
            <div className='spinner'>
                <div className='dot dot-one'></div>
                <div className='dot dot-two'></div>
                <div className='dot dot-three'></div>
                <div className='dot dot-four'></div>
                <div className='dot dot-five'></div>
                <div className='dot dot-six'></div>
                <div className='dot dot-seven'></div>
                <div className='dot dot-eight'></div>
                <div className='dot dot-nine'></div>
                <div className='dot dot-ten'></div>
                <div className='dot dot-eleven'></div>
                <div className='dot dot-twelve'></div>
            </div>
        </div>
    }
}

define([], () => LoadingSpinner)